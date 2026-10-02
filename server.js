import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { timingSafeEqual } from "crypto";
import rateLimit from "express-rate-limit";
import pkg from 'pg';
import { Resend } from "resend";
import Stripe from "stripe";
import { PostHog } from "posthog-node";
import { mountMcp } from "./mcp-remote.js";

const { Pool } = pkg;

dotenv.config({ path: "./.env.local" });
const app = express();
app.set("trust proxy", 1);
const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.DB_PORT,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false
});

// Stripe signs the raw request body, so the webhook is mounted before express.json().
app.post("/billing/webhook", express.raw({ type: "application/json" }), (req, res) => handleStripeWebhook(req, res));

// Remote MCP endpoint has its own CORS, body parsing and rate limits (its traffic comes
// from shared AI-provider IPs), so it's mounted before the global middleware.
mountMcp(app, { pool, chargeLookups: (...args) => chargeLookups(...args), track: (...args) => track(...args) });

app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key, x-admin-key");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" }
});
app.use(globalLimiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later" }
});

const SECRET_KEY = process.env.JWT_SECRET;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Public URL of this API (where the /verify link points) and of the marketing site.
const APP_URL = (process.env.APP_URL || "https://vessel-class-finder-production.up.railway.app").replace(/\/$/, "");
const SITE_URL = (process.env.SITE_URL || "https://vesselclassfinder.com").replace(/\/$/, "");

// 📌 Stripe billing — disabled (endpoints return 503) until STRIPE_SECRET_KEY is set.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_PRICES = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
};

// 📌 Product analytics — disabled until POSTHOG_KEY is set. Events are keyed by the
// user's UUID (never the email), matching the id the website identifies with.
const posthog = process.env.POSTHOG_KEY
    ? new PostHog(process.env.POSTHOG_KEY, { host: process.env.POSTHOG_HOST || "https://eu.i.posthog.com", disableGeoip: true })
    : null;

function track(userId, event, properties = {}) {
    if (!posthog || !userId) return;
    try {
        posthog.capture({ distinctId: String(userId), event, properties: { ...properties, source: "api" } });
    } catch (e) {
        console.error("Analytics capture failed:", e.message);
    }
}

// How long an email-verification link stays valid.
const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 📌 Startup migration — adds email-verification columns idempotently.
// Wrapped so a migration hiccup can never crash Railway startup.
async function runMigrations() {
    try {
        await pool.query(`
            ALTER TABLE users
                ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS verification_token TEXT,
                ADD COLUMN IF NOT EXISTS verification_sent_at TIMESTAMPTZ
        `);
        // Grandfather everyone who registered before verification existed: they have
        // no pending token, so mark them verified and don't lock them out. New signups
        // get a token on insert and stay unverified until they click the link.
        await pool.query("UPDATE users SET verified = TRUE WHERE verification_token IS NULL AND verified = FALSE");
        console.log("✅ Verification migration applied");
    } catch (e) {
        console.error("⚠️  Verification migration failed (continuing):", e.message);
    }
    try {
        await pool.query(`
            ALTER TABLE subscriptions
                ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
                ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT
        `);
        // One alert per threshold per month: the flags live on the monthly usage row.
        await pool.query(`
            ALTER TABLE api_usage
                ADD COLUMN IF NOT EXISTS warned_80 BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS warned_100 BOOLEAN NOT NULL DEFAULT FALSE
        `);
        console.log("✅ Billing migration applied");
    } catch (e) {
        console.error("⚠️  Billing migration failed (continuing):", e.message);
    }
}

// 📌 Usage retention — the privacy policy promises usage records are kept for
// 12 months. Deletes months older than that; runs at startup and daily.
const USAGE_RETENTION_MONTHS = 12;

async function pruneOldUsage() {
    try {
        const result = await pool.query(
            "DELETE FROM api_usage WHERE month < to_char(date_trunc('month', now()) - make_interval(months => $1), 'YYYY-MM')",
            [USAGE_RETENTION_MONTHS]
        );
        if (result.rowCount > 0) console.log(`🧹 Pruned ${result.rowCount} usage rows older than ${USAGE_RETENTION_MONTHS} months`);
    } catch (e) {
        console.error("⚠️  Usage pruning failed (continuing):", e.message);
    }
}

// 📌 Email validation — blocks bot signups and protects email-sending reputation.
// RFC 2606 reserved domains can NEVER receive mail, so welcome emails to them
// always hard-bounce, which damages our Resend sender reputation.
const RESERVED_DOMAINS = new Set([
    "example.com", "example.net", "example.org", "example.edu",
    "test", "test.com", "invalid", "localhost", "local", "domain.com",
    "email.com", "mail.com", "yourdomain.com", "yourcompany.com",
]);

const DISPOSABLE_DOMAINS = new Set([
    "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
    "temp-mail.org", "throwawaymail.com", "yopmail.com", "trashmail.com",
    "getnada.com", "sharklasers.com", "maildrop.cc", "dispostable.com",
    "fakeinbox.com", "mailnesia.com", "mohmal.com", "emailondeck.com",
    "spam4.me", "grr.la", "guerrillamail.info", "mailcatch.com",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns an error message string if invalid, or null if the email is acceptable.
function validateEmail(email) {
    if (typeof email !== "string") return "Invalid email address";
    const normalized = email.trim().toLowerCase();
    if (normalized.length < 6 || normalized.length > 254 || !EMAIL_RE.test(normalized)) {
        return "Invalid email address";
    }
    const domain = normalized.split("@")[1];
    if (RESERVED_DOMAINS.has(domain) || DISPOSABLE_DOMAINS.has(domain)) {
        return "Please use a valid, non-disposable email address";
    }
    return null;
}

// Dedicated limiter for account creation: stricter than login, per-IP.
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many accounts created from this network. Try again later." }
});

async function sendVerificationEmail(email, token) {
    if (!resend) return;
    const verifyUrl = `${APP_URL}/verify?token=${encodeURIComponent(token)}`;
    try {
        await resend.emails.send({
            from: "VesselClassFinder <konstantinos@wearefabbrik.com>",
            to: email,
            subject: "Confirm your email to activate your VesselClassFinder account",
            html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1);">
        <tr>
          <td style="background:#0f172a;padding:28px 40px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">vessel<span style="color:#3b82f6;">class</span>finder</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;">Confirm your email</h1>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
              Thanks for signing up. Please confirm this email address to activate your account and unlock your API key.
            </p>
            <a href="${verifyUrl}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;margin:0 0 24px;">Confirm my email →</a>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#94a3b8;">
              Or paste this link into your browser:
            </p>
            <p style="margin:0 0 24px;font-size:13px;line-height:1.6;word-break:break-all;">
              <a href="${verifyUrl}" style="color:#3b82f6;text-decoration:none;">${verifyUrl}</a>
            </p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">
              This link expires in 7 days. If you didn't create this account, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              Questions? Reply to this email or check our <a href="${SITE_URL}/#api" style="color:#3b82f6;text-decoration:none;">API docs</a>.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
        });
    } catch (e) {
        console.error("Verification email failed:", e.message);
    }
}

// Branded email wrapper: header, white content card, footer.
function emailShell(content) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1);">
        <tr>
          <td style="background:#0f172a;padding:28px 40px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">vessel<span style="color:#3b82f6;">class</span>finder</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px;">${content}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              Questions? Reply to this email or check our <a href="${SITE_URL}/#api" style="color:#3b82f6;text-decoration:none;">API docs</a>.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Minimal branded HTML page shown after clicking a verification link.
function verifyResultPage({ heading, body, cta }) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${heading} — VesselClassFinder</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:60px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.1);">
        <tr><td style="background:#0f172a;padding:24px 40px;">
          <p style="margin:0;font-size:18px;font-weight:700;color:#ffffff;">vessel<span style="color:#3b82f6;">class</span>finder</p>
        </td></tr>
        <tr><td style="padding:40px;text-align:center;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${heading}</h1>
          <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#475569;">${body}</p>
          ${cta}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function notifyTelegram(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" })
        });
    } catch (e) {
        console.error("Telegram notification failed:", e.message);
    }
}

// 📌 Register a New User
app.post("/register", registerLimiter, authLimiter, async (req, res) => {
    const { email, password, website } = req.body;

    // Honeypot: `website` is a hidden field real users never see. A bot that
    // fills it gets a fake success — no account, no email, no Telegram alert.
    if (website) return res.json({ message: "User registered" });

    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const emailError = validateEmail(email);
    if (emailError) return res.status(400).json({ error: emailError });

    if (typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = uuidv4();

    try {
        const result = await pool.query(
            "INSERT INTO users (email, password_hash, verified, verification_token, verification_sent_at) VALUES ($1, $2, FALSE, $3, NOW()) RETURNING id",
            [normalizedEmail, hashedPassword, verificationToken]
        );
        res.json({ message: "Registered. Check your email to verify your account and activate your API key.", userId: result.rows[0].id });
        notifyTelegram(`New signup (pending verification): ${escapeHtml(normalizedEmail)}`);
        track(result.rows[0].id, "user_signed_up");
        sendVerificationEmail(normalizedEmail, verificationToken);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "User already exists or database error" });
    }
});

// 📌 Verify a user's email via the link sent at registration
app.get("/verify", async (req, res) => {
    const token = req.query.token;
    if (!token || typeof token !== "string") {
        return res.status(400).send(verifyResultPage({
            heading: "Invalid link",
            body: "This verification link is missing its token. Please use the link from your email.",
            cta: `<a href="${SITE_URL}/#signup" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Back to sign up</a>`
        }));
    }

    try {
        const result = await pool.query(
            "SELECT id, verified, verification_sent_at FROM users WHERE verification_token = $1",
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(400).send(verifyResultPage({
                heading: "Link already used or invalid",
                body: "This link is no longer valid. If you've already verified, just log in. Otherwise, request a new link.",
                cta: `<a href="${SITE_URL}/#signup" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Go to login</a>`
            }));
        }

        const user = result.rows[0];
        const sentAt = user.verification_sent_at ? new Date(user.verification_sent_at).getTime() : 0;
        if (Date.now() - sentAt > VERIFICATION_TTL_MS) {
            return res.status(400).send(verifyResultPage({
                heading: "Link expired",
                body: "This verification link has expired. Please request a new one from the sign-up page.",
                cta: `<a href="${SITE_URL}/#signup" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Request a new link</a>`
            }));
        }

        await pool.query(
            "UPDATE users SET verified = TRUE, verification_token = NULL WHERE id = $1",
            [user.id]
        );
        track(user.id, "email_verified");

        res.status(200).send(verifyResultPage({
            heading: "Email verified ✓",
            body: "Your account is active. Log in on the sign-up page to get your API key.",
            cta: `<a href="${SITE_URL}/#signup" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Log in &amp; get API key</a>`
        }));
    } catch (error) {
        console.error(error);
        res.status(500).send(verifyResultPage({
            heading: "Something went wrong",
            body: "We couldn't verify your email right now. Please try the link again in a moment.",
            cta: `<a href="${SITE_URL}/#signup" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Back to site</a>`
        }));
    }
});

// 📌 Resend a verification email for an unverified account
app.post("/resend-verification", registerLimiter, authLimiter, async (req, res) => {
    const { email } = req.body;
    // Always respond the same way so this can't be used to probe which emails exist.
    const genericOk = { message: "If that account exists and is unverified, a new link is on its way." };

    if (validateEmail(email)) return res.json(genericOk);
    const normalizedEmail = email.trim().toLowerCase();

    try {
        const result = await pool.query(
            "SELECT id, verified FROM users WHERE lower(email) = $1",
            [normalizedEmail]
        );
        if (result.rows.length > 0 && result.rows[0].verified === false) {
            const newToken = uuidv4();
            await pool.query(
                "UPDATE users SET verification_token = $1, verification_sent_at = NOW() WHERE id = $2",
                [newToken, result.rows[0].id]
            );
            sendVerificationEmail(normalizedEmail, newToken);
        }
        res.json(genericOk);
    } catch (error) {
        console.error(error);
        res.json(genericOk);
    }
});

// 📌 User Login & API Key Generation
app.post("/login", authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (typeof email !== "string" || typeof password !== "string") {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        // Registration stores emails lowercased; lower() also matches older mixed-case rows.
        const result = await pool.query("SELECT * FROM users WHERE lower(email) = $1", [email.trim().toLowerCase()]);

        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

        const user = result.rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) return res.status(401).json({ error: "Invalid credentials" });

        if (user.verified === false) {
            return res.status(403).json({ error: "Please verify your email before logging in. Check your inbox for the verification link.", unverified: true });
        }

        const token = jwt.sign({ userId: user.id, email: user.email }, SECRET_KEY, { expiresIn: "7d" });

        // Reuse the newest active API key; only mint one if the user has none.
        const keyResult = await pool.query(
            "SELECT api_key FROM api_keys WHERE user_id = $1 AND active = TRUE ORDER BY created_at DESC LIMIT 1",
            [user.id]
        );
        let apiKey = keyResult.rows[0]?.api_key;
        if (!apiKey) {
            apiKey = uuidv4();
            await pool.query("INSERT INTO api_keys (user_id, api_key) VALUES ($1, $2)", [user.id, apiKey]);
        }

        res.json({ message: "Login successful", token, apiKey, userId: user.id });
        track(user.id, "user_logged_in");
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 📌 Middleware: Validate API Key
const authenticateAPIKey = async (req, res, next) => {
    try {
        const apiKey = req.headers["x-api-key"];
        if (!apiKey) return res.status(403).json({ error: "API key required" });

        const result = await pool.query("SELECT user_id FROM api_keys WHERE api_key = $1 AND active = TRUE", [apiKey]);

        if (result.rows.length === 0) return res.status(403).json({ error: "Invalid or inactive API key" });

        req.userId = result.rows[0].user_id;
        next();
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 📌 Middleware: Admin-only routes. Requires x-admin-key to match ADMIN_API_KEY;
// if ADMIN_API_KEY is unset, admin routes are disabled entirely.
const authenticateAdmin = (req, res, next) => {
    const expected = process.env.ADMIN_API_KEY;
    const provided = req.headers["x-admin-key"];
    if (!expected || typeof provided !== "string") return res.status(403).json({ error: "Admin access required" });
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(403).json({ error: "Admin access required" });
    next();
};

// 📌 Middleware: Validate IMO list. Runs before usage accounting so bad requests
// don't consume quota. Duplicates are removed so each vessel is billed once.
const MAX_IMOS_PER_REQUEST = 100;

const validateImos = (req, res, next) => {
    const { imos } = req.body;
    if (!imos || !Array.isArray(imos)) return res.status(400).json({ error: "Provide an array of IMOs" });
    if (imos.length === 0) return res.status(400).json({ error: "Provide at least one IMO" });

    const invalid = imos.filter(imo => !/^\d{1,7}$/.test(String(imo)));
    if (invalid.length > 0) {
        return res.status(400).json({ error: "IMO numbers must be positive integers of up to 7 digits", invalid: invalid.slice(0, 10) });
    }

    const unique = [...new Set(imos.map(imo => Number(imo)))];
    if (unique.length > MAX_IMOS_PER_REQUEST) {
        return res.status(400).json({ error: `At most ${MAX_IMOS_PER_REQUEST} IMOs per request` });
    }

    req.imos = unique;
    next();
};

// 📌 Middleware: Check Usage Limits
const PLAN_LIMITS = { free: 100, starter: 5000, pro: 50000, enterprise: Infinity };
const UPGRADE_URL = `${SITE_URL}/#pricing`;

// Suggested next step up from each plan, used in usage-alert emails.
const NEXT_PLAN = {
    free: "Starter ($49/mo, 5,000 lookups)",
    starter: "Pro ($199/mo, 50,000 lookups)",
    pro: "Enterprise (unlimited lookups)",
};

// Emails the user once per month when they reach 80% or 100% of their plan.
// The conditional UPDATE claims the flag, so concurrent requests send one email.
async function sendUsageAlert(userId, month, level, { plan, limit }) {
    if (!resend) return;
    const flag = level === 100 ? "warned_100" : "warned_80";
    try {
        const claimed = await pool.query(
            `UPDATE api_usage SET ${flag} = TRUE FROM users
             WHERE api_usage.user_id = $1 AND api_usage.month = $2 AND api_usage.${flag} = FALSE AND users.id = api_usage.user_id
             RETURNING users.email`,
            [userId, month]
        );
        if (!claimed?.rows?.length) return;
        const email = claimed.rows[0].email;
        const limitText = limit.toLocaleString("en-US");
        const heading = level === 100
            ? `You've used all ${limitText} lookups this month`
            : `You've used 80% of your ${limitText} monthly lookups`;
        const body = level === 100
            ? "Further requests will return HTTP 429 until your quota resets on the 1st of next month."
            : "At this rate you may hit your limit before the month ends, and requests will start returning HTTP 429.";
        const next = NEXT_PLAN[plan];
        const cta = plan === "pro"
            ? `<a href="mailto:info@wearefabbrik.com?subject=Vessel%20Class%20Finder%20-%20Enterprise" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Talk to us about Enterprise →</a>`
            : `<a href="${UPGRADE_URL}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Upgrade my plan →</a>`;
        await resend.emails.send({
            from: "VesselClassFinder <konstantinos@wearefabbrik.com>",
            to: email,
            subject: heading,
            html: emailShell(`
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;">${heading}</h1>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">${body}</p>
            ${next ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475569;">Need more? Move up to <strong>${next}</strong>.</p>` : ""}
            ${cta}`)
        });
    } catch (e) {
        console.error("Usage alert failed:", e.message);
    }
}

// Charges `cost` lookups to the user's monthly quota. Check and charge happen in one
// statement so concurrent requests can't both pass the check and overshoot the limit.
// Returns { ok: true, plan, limit, used } or { ok: false, plan, limit, usage }.
async function chargeLookups(userId, cost) {
    const month = new Date().toISOString().slice(0, 7);

    const subResult = await pool.query(
        "SELECT plan, status, expires_at FROM subscriptions WHERE user_id = $1",
        [userId]
    );

    let plan = "free";
    if (subResult.rows.length > 0) {
        const sub = subResult.rows[0];
        if (sub.status === "active" && new Date(sub.expires_at) > new Date()) {
            plan = sub.plan || "starter";
        }
    }

    const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    const charged = await pool.query(
        `INSERT INTO api_usage (user_id, month, request_count)
            SELECT $1, $2, $3::int WHERE $4::int IS NULL OR $3::int <= $4::int
         ON CONFLICT (user_id, month) DO UPDATE
            SET request_count = api_usage.request_count + $3::int
            WHERE $4::int IS NULL OR api_usage.request_count + $3::int <= $4::int
         RETURNING request_count`,
        [userId, month, cost, limit === Infinity ? null : limit]
    );

    if (charged.rows.length === 0) {
        const usageResult = await pool.query(
            "SELECT request_count FROM api_usage WHERE user_id = $1 AND month = $2",
            [userId, month]
        );
        const usage = usageResult.rows.length > 0 ? usageResult.rows[0].request_count : 0;
        // A batch can be refused while some quota remains; only alert once it's all used.
        if (usage >= limit) sendUsageAlert(userId, month, 100, { plan, limit });
        track(userId, "usage_limit_reached", { plan, limit, usage, requested: cost });
        return { ok: false, plan, limit, usage };
    }

    const used = charged.rows[0].request_count;
    if (limit !== Infinity) {
        if (used >= limit) sendUsageAlert(userId, month, 100, { plan, limit });
        else if (used - cost < limit * 0.8 && used >= limit * 0.8) sendUsageAlert(userId, month, 80, { plan, limit });
    }
    return { ok: true, plan, limit, used };
}

const checkUsageLimit = async (req, res, next) => {
    try {
        // Each IMO looked up counts as one lookup.
        const cost = req.imos ? req.imos.length : 1;
        const result = await chargeLookups(req.userId, cost);

        if (!result.ok) {
            return res.status(429).json({
                error: `Monthly lookup limit reached. Upgrade your plan at ${UPGRADE_URL}`,
                upgrade_url: UPGRADE_URL,
                usage: result.usage,
                requested: cost,
                limit: result.limit,
                plan: result.plan
            });
        }

        req.plan = result.plan;
        req.usageCount = result.used;
        req.usageLimit = result.limit;
        next();
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 📌 API: Fetch Vessel Data by IMO
app.post("/vessels", authenticateAPIKey, validateImos, checkUsageLimit, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM vessel_data WHERE imo = ANY($1::bigint[])", [req.imos]);

        res.json(result.rows);
        track(req.userId, "api_lookup", { imos: req.imos.length, found: result.rows.length, plan: req.plan });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 📌 API: Get Subscription Status
app.get("/subscription", authenticateAPIKey, async (req, res) => {
    try {
        const result = await pool.query("SELECT status, expires_at FROM subscriptions WHERE user_id = $1", [req.userId]);
        if (result.rows.length === 0) return res.json({ status: "inactive" });

        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 📌 API: Activate Subscription (admin only, x-admin-key header)
const PAID_PLANS = ["starter", "pro", "enterprise"];

app.post("/subscribe", authenticateAdmin, async (req, res) => {
    try {
        const { email, plan = "starter" } = req.body;
        if (typeof email !== "string") return res.status(400).json({ error: "Missing email" });
        if (!PAID_PLANS.includes(plan)) return res.status(400).json({ error: `plan must be one of: ${PAID_PLANS.join(", ")}` });

        const userResult = await pool.query("SELECT id FROM users WHERE lower(email) = $1", [email.trim().toLowerCase()]);

        if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });

        const userId = userResult.rows[0].id;
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1); // 1-month subscription

        await pool.query(
            "INSERT INTO subscriptions (user_id, status, expires_at, plan) VALUES ($1, 'active', $2, $3) ON CONFLICT (user_id) DO UPDATE SET status = 'active', expires_at = $2, plan = $3",
            [userId, expiresAt, plan]
        );

        res.json({ message: "Subscription activated", plan, expires_at: expiresAt });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 📌 API: Get Current Usage
app.get("/usage", authenticateAPIKey, async (req, res) => {
    try {
        const month = new Date().toISOString().slice(0, 7);

        const subResult = await pool.query(
            "SELECT plan, status, expires_at FROM subscriptions WHERE user_id = $1",
            [req.userId]
        );

        let plan = "free";
        if (subResult.rows.length > 0) {
            const sub = subResult.rows[0];
            if (sub.status === "active" && new Date(sub.expires_at) > new Date()) {
                plan = sub.plan || "starter";
            }
        }

        const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

        const usageResult = await pool.query(
            "SELECT request_count FROM api_usage WHERE user_id = $1 AND month = $2",
            [req.userId, month]
        );

        const used = usageResult.rows.length > 0 ? usageResult.rows[0].request_count : 0;

        res.json({ month, used, limit: limit === Infinity ? "unlimited" : limit, plan });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 📌 API: List User's API Keys
app.get("/api-keys", authenticateAPIKey, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT api_key, active, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC",
            [req.userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 📌 API: Revoke an API Key
app.delete("/api-keys/:key", authenticateAPIKey, async (req, res) => {
    try {
        const result = await pool.query(
            "UPDATE api_keys SET active = FALSE WHERE api_key = $1 AND user_id = $2 AND active = TRUE RETURNING api_key",
            [req.params.key, req.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "API key not found or already revoked" });
        res.json({ message: "API key revoked" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 📌 Billing: Stripe Checkout for self-serve upgrades
app.post("/billing/checkout", authenticateAPIKey, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "Billing is not available yet. Contact info@wearefabbrik.com to upgrade." });
    const { plan } = req.body;
    const price = STRIPE_PRICES[plan];
    if (!price) return res.status(400).json({ error: "plan must be one of: starter, pro" });

    try {
        const userResult = await pool.query(
            "SELECT users.email, subscriptions.stripe_customer_id, subscriptions.stripe_subscription_id, subscriptions.status, subscriptions.expires_at FROM users LEFT JOIN subscriptions ON subscriptions.user_id = users.id WHERE users.id = $1",
            [req.userId]
        );
        const user = userResult.rows[0];
        if (!user) return res.status(404).json({ error: "User not found" });

        // Plan changes for existing subscribers go through the billing portal, so
        // nobody ends up paying for two subscriptions at once.
        if (user.status === "active" && new Date(user.expires_at) > new Date()) {
            // Plans granted by hand (e.g. Enterprise) have no Stripe subscription to manage.
            if (!user.stripe_subscription_id) {
                return res.status(409).json({ error: "Your plan is managed by our team. Contact info@wearefabbrik.com to change it." });
            }
            return res.status(409).json({ error: "You already have an active subscription. Use Manage billing to change plans.", portal: true });
        }

        const userId = String(req.userId);
        track(req.userId, "checkout_started", { plan });
        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            line_items: [{ price, quantity: 1 }],
            client_reference_id: userId,
            ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : { customer_email: user.email }),
            subscription_data: { metadata: { userId } },
            metadata: { userId },
            allow_promotion_codes: true,
            success_url: `${SITE_URL}/?checkout=success#account`,
            cancel_url: `${SITE_URL}/?checkout=cancel#pricing`,
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Could not start checkout" });
    }
});

// 📌 Billing: Stripe customer portal (change plan, update card, cancel, invoices)
app.post("/billing/portal", authenticateAPIKey, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "Billing is not available yet." });
    try {
        const result = await pool.query("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [req.userId]);
        const customer = result.rows[0]?.stripe_customer_id;
        if (!customer) return res.status(404).json({ error: "No billing account yet. Choose a plan to subscribe." });

        // The Stripe account is shared with other products, so use a dedicated portal
        // configuration (plan switching between our prices) when one is set.
        const session = await stripe.billingPortal.sessions.create({
            customer,
            return_url: `${SITE_URL}/#account`,
            ...(process.env.STRIPE_PORTAL_CONFIG ? { configuration: process.env.STRIPE_PORTAL_CONFIG } : {}),
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Could not open billing portal" });
    }
});

// Copies a Stripe subscription's state onto our subscriptions row. Always called
// with a freshly retrieved subscription, so out-of-order webhooks can't regress it,
// and an ended subscription never overwrites a different (newer) one on the row.
const SUBSCRIPTION_GRACE_MS = 2 * 24 * 60 * 60 * 1000; // renewal webhooks can lag the period end

const SUBSCRIPTION_EVENTS = {
    "checkout.session.completed": "subscription_started",
    "customer.subscription.updated": "subscription_updated",
    "customer.subscription.deleted": "subscription_ended",
};

async function syncSubscription(sub, eventType) {
    const userId = sub.metadata?.userId;
    if (!userId) {
        console.error(`Stripe subscription ${sub.id} has no userId metadata; skipping`);
        return;
    }
    const item = sub.items?.data?.[0];
    const priceId = item?.price?.id;
    const plan = Object.keys(STRIPE_PRICES).find(p => STRIPE_PRICES[p] === priceId);
    const live = ["active", "trialing", "past_due"].includes(sub.status);
    // current_period_end moved from the subscription to its items in newer API versions.
    const periodEnd = sub.current_period_end ?? item?.current_period_end;
    const expiresAt = live && periodEnd ? new Date(periodEnd * 1000 + SUBSCRIPTION_GRACE_MS) : new Date();
    const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

    if (live && !plan) console.error(`Stripe price ${priceId} doesn't match STRIPE_PRICE_STARTER/PRO`);

    await pool.query(
        `INSERT INTO subscriptions (user_id, status, expires_at, plan, stripe_customer_id, stripe_subscription_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE SET status = $2, expires_at = $3, plan = COALESCE($4, subscriptions.plan),
             stripe_customer_id = $5, stripe_subscription_id = $6
         WHERE $7 OR subscriptions.stripe_subscription_id IS NULL OR subscriptions.stripe_subscription_id = $6`,
        // subscriptions.status has a CHECK constraint allowing only 'active' / 'inactive'.
        [userId, live && plan ? "active" : "inactive", expiresAt, plan || null, customer, sub.id, live]
    );
    if (live && plan) notifyTelegram(`💳 Subscription ${sub.status}: user ${escapeHtml(userId)} on ${plan}`);
    // customer.subscription.created duplicates checkout.session.completed, so it isn't tracked.
    if (SUBSCRIPTION_EVENTS[eventType]) {
        track(userId, SUBSCRIPTION_EVENTS[eventType], { plan: plan || null, stripe_status: sub.status });
    }
}

async function handleStripeWebhook(req, res) {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: "Billing not configured" });

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
        return res.status(400).json({ error: `Webhook signature verification failed: ${e.message}` });
    }

    try {
        let subscriptionId = null;
        if (event.type === "checkout.session.completed" && event.data.object.mode === "subscription") {
            subscriptionId = event.data.object.subscription;
        } else if (event.type.startsWith("customer.subscription.")) {
            subscriptionId = event.data.object.id;
        }
        if (subscriptionId) {
            await syncSubscription(await stripe.subscriptions.retrieve(subscriptionId), event.type);
        }
        res.json({ received: true });
    } catch (error) {
        if (error.code === "23503") {
            // userId in the subscription metadata no longer exists; retrying won't help.
            console.error("Stripe webhook for a deleted user; skipping:", error.detail);
            return res.json({ received: true });
        }
        console.error(error);
        // Non-2xx makes Stripe retry the event later.
        res.status(500).json({ error: "Webhook handling failed" });
    }
}

// 📌 Public demo lookup for the homepage: one IMO at a time, tightly rate-limited
// per IP so it can't be used to scrape the dataset.
const demoLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demo limit reached. Get a free API key for 100 lookups a month." }
});

app.get("/demo/:imo", demoLimiter, async (req, res) => {
    if (!/^\d{7}$/.test(req.params.imo)) return res.status(400).json({ error: "IMO numbers have 7 digits" });
    try {
        const result = await pool.query(
            "SELECT imo, vessel_name, class, status, date_of_survey, date_of_next_survey, date_of_latest_status, reason_for_status FROM vessel_data WHERE imo = $1",
            [Number(req.params.imo)]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "No IACS-classed vessel with that IMO number" });
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
});

export { app, pool, pruneOldUsage };

// 📌 Start Server
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "test") {
    runMigrations().finally(() => {
        app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
        // Railway sends SIGTERM on redeploy; flush queued analytics events before exiting.
        process.on("SIGTERM", async () => {
            if (posthog) await posthog.shutdown().catch(() => {});
            process.exit(0);
        });
        pruneOldUsage();
        setInterval(pruneOldUsage, 24 * 60 * 60 * 1000).unref();
    });
}