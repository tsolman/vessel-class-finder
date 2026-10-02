// 📌 Remote MCP endpoint (Streamable HTTP, stateless) for Claude's Connectors Directory
// and other MCP clients. Mounted at /mcp by server.js.
//
// Without credentials only lookup_vessel works, against a shared daily budget (all
// claude.ai traffic arrives from Anthropic's IPs, so per-IP limits don't apply).
// With an API key (Authorization: Bearer <key> or x-api-key) lookups are charged to
// the user's plan like POST /vessels, and the batch tools unlock.
import express from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { enrichVessel, normalizeImo, normalizeImos } from "./mcp/src/client.js";

const SIGNUP_URL = "https://vesselclassfinder.com/#signup";
const STATUS_HELP =
    "Status meanings: Delivered, Reinstated and Reassigned mean the ship is in class (in_class true); " +
    "Suspended means class is temporarily invalid; Withdrawn means the society no longer classes it (in_class false). " +
    "Society codes: NKK=ClassNK, NV=DNV, LRS=Lloyd's Register, TLV=Türk Loydu; others use their usual initials.";
const DISCLAIMER = "Data is the IACS Vessels in Class dataset, refreshed weekly; it is not a substitute for class certificates.";
const COLUMNS = "imo, vessel_name, class, status, date_of_survey, date_of_next_survey, date_of_latest_status, reason_for_status";

// Shared daily budget for unauthenticated lookups, reset at UTC midnight.
const PUBLIC_DAILY_LIMIT = Number(process.env.MCP_PUBLIC_DAILY_LIMIT || 500);
const publicBudget = { day: "", used: 0 };

function takePublicLookup() {
    const day = new Date().toISOString().slice(0, 10);
    if (publicBudget.day !== day) Object.assign(publicBudget, { day, used: 0 });
    if (publicBudget.used >= PUBLIC_DAILY_LIMIT) return false;
    publicBudget.used += 1;
    return true;
}

class ToolError extends Error {}

const ok = (result) => ({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

function wrap(fn) {
    return async (args) => {
        try {
            return ok(await fn(args));
        } catch (err) {
            if (err instanceof ToolError || err?.name === "ToolError") return fail(err.message);
            console.error("MCP tool error:", err);
            return fail("Internal error looking up vessels. Please try again later.");
        }
    };
}

function apiKeyFrom(req) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
    const key = req.headers["x-api-key"];
    return typeof key === "string" && key.trim() ? key.trim() : null;
}

function limitError(result, cost) {
    return new ToolError(
        `Monthly lookup limit reached (plan: ${result.plan}, used ${result.usage} of ${result.limit}, this call needs ${cost}). ` +
        `Upgrade at https://vesselclassfinder.com/#pricing`
    );
}

function buildServer({ pool, userId, chargeLookups, track }) {
    const server = new McpServer({ name: "vessel-class-finder", version: "1.0.0" });
    const needKey = () => new ToolError(
        `This tool needs a Vessel Class Finder API key. Get a free one (100 lookups/month) at ${SIGNUP_URL} ` +
        "and connect with it as a Bearer token or x-api-key header. Without a key, use lookup_vessel for one ship at a time."
    );

    async function fetchVessels(imos) {
        const result = await pool.query(`SELECT ${COLUMNS} FROM vessel_data WHERE imo = ANY($1::bigint[])`, [imos.map(Number)]);
        return result.rows.map(enrichVessel);
    }

    server.registerTool(
        "lookup_vessel",
        {
            title: "Look up a ship's class status",
            description:
                "Look up which IACS classification society classes ONE ship and its class status, by 7-digit IMO number. " +
                "Use when the user asks whether a ship is in class, who classes it, or when its next class survey is due. " +
                "Returns vessel_name, class (society code), society (full name), status, in_class, last and next survey dates, and the reason for the latest status change. " +
                STATUS_HELP + " If found is false, the ship is not classed by an IACS member or the IMO is wrong. " +
                "Works without an API key (shared daily allowance); for many ships use lookup_vessels.",
            inputSchema: { imo: z.union([z.string(), z.number()]).describe('A 7-digit IMO number, e.g. "9321483".') },
            annotations: { title: "Look up a ship's class status", readOnlyHint: true, openWorldHint: false },
        },
        wrap(async ({ imo }) => {
            const normalized = normalizeImo(imo);
            if (userId) {
                const charge = await chargeLookups(userId, 1);
                if (!charge.ok) throw limitError(charge, 1);
            } else if (!takePublicLookup()) {
                throw new ToolError(`The free daily allowance for keyless lookups is used up. Get a free API key (100 lookups/month) at ${SIGNUP_URL}, or try again tomorrow.`);
            }
            track(userId || "mcp-public", "mcp_tool_called", { tool: "lookup_vessel", authenticated: Boolean(userId) });
            const [vessel] = await fetchVessels([normalized]);
            return vessel
                ? { found: true, vessel, disclaimer: DISCLAIMER }
                : { found: false, imo: normalized, note: "Not in IACS data: the ship is not classed by an IACS member, or the IMO is wrong.", disclaimer: DISCLAIMER };
        })
    );

    server.registerTool(
        "lookup_vessels",
        {
            title: "Look up class status for many ships",
            description:
                "Look up IACS class society and status for 1-100 ships by IMO number in one call, e.g. to screen a fleet or a list of nominated vessels for suspended or withdrawn class. " +
                "Returns each vessel's details plus not_found (IMOs absent from IACS data). " + STATUS_HELP +
                " Requires the user's API key; each unique IMO counts as one lookup against their monthly plan.",
            inputSchema: {
                imos: z.array(z.union([z.string(), z.number()])).min(1).max(100).describe('IMO numbers, 1-100 items, e.g. ["9321483", "9074729"].'),
            },
            annotations: { title: "Look up class status for many ships", readOnlyHint: true, openWorldHint: false },
        },
        wrap(async ({ imos }) => {
            if (!userId) throw needKey();
            const unique = normalizeImos(imos);
            const charge = await chargeLookups(userId, unique.length);
            if (!charge.ok) throw limitError(charge, unique.length);
            track(userId, "mcp_tool_called", { tool: "lookup_vessels", imos: unique.length, authenticated: true });
            const vessels = await fetchVessels(unique);
            const found = new Set(vessels.map((v) => String(v.imo)));
            const not_found = unique.filter((imo) => !found.has(imo));
            return { requested: unique.length, found: vessels.length, vessels, not_found, disclaimer: DISCLAIMER };
        })
    );

    server.registerTool(
        "check_usage",
        {
            title: "Check API usage",
            description: "Show the connected account's plan and how many lookups are used and remaining this month. Requires the user's API key.",
            inputSchema: {},
            annotations: { title: "Check API usage", readOnlyHint: true, openWorldHint: false },
        },
        wrap(async () => {
            if (!userId) throw needKey();
            // A zero-cost charge reads plan and usage through the same path as real lookups.
            const r = await chargeLookups(userId, 0);
            const used = r.ok ? r.used : r.usage;
            const unlimited = r.limit === Infinity;
            return { plan: r.plan, used, limit: unlimited ? "unlimited" : r.limit, remaining: unlimited ? "unlimited" : Math.max(r.limit - used, 0) };
        })
    );

    return server;
}

export function mountMcp(app, { pool, chargeLookups, track }) {
    // All claude.ai traffic shares Anthropic's IPs, so this per-IP limit is only a flood guard.
    const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });

    const cors = (req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id");
        res.header("Access-Control-Expose-Headers", "mcp-session-id");
        res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        if (req.method === "OPTIONS") return res.sendStatus(204);
        next();
    };

    app.post("/mcp", cors, limiter, express.json(), async (req, res) => {
        let userId = null;
        const key = apiKeyFrom(req);
        try {
            if (key) {
                const result = await pool.query("SELECT user_id FROM api_keys WHERE api_key = $1 AND active = TRUE", [key]);
                if (result.rows.length === 0) {
                    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Invalid or inactive API key" }, id: null });
                }
                userId = result.rows[0].user_id;
            }
            const server = buildServer({ pool, userId, chargeLookups, track });
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
            res.on("close", () => { transport.close(); server.close(); });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error("MCP request failed:", error);
            if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
        }
    });

    // Stateless server: no SSE stream or sessions to resume or end.
    const notAllowed = (req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    app.options("/mcp", cors);
    app.get("/mcp", cors, notAllowed);
    app.delete("/mcp", cors, notAllowed);
}

export { takePublicLookup, publicBudget, PUBLIC_DAILY_LIMIT };
