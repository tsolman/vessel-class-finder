import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import pkg from 'pg';
import { Resend } from "resend";

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

app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
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
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendConfirmationEmail(email) {
    if (!process.env.RESEND_API_KEY) return;
    try {
        await resend.emails.send({
            from: "VesselClassFinder <konstantinos@wearefabbrik.com>",
            to: email,
            subject: "Welcome to VesselClassFinder — your API key is ready",
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
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;">Welcome aboard!</h1>
            <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
              Thanks for signing up. Your account is active and your API key has been generated — you're ready to start querying IACS vessel classification data.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#f1f5f9;border-radius:6px;padding:16px 20px;">
                  <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Free tier includes</p>
                  <p style="margin:0;font-size:14px;color:#0f172a;line-height:1.7;">
                    ✓ 100 vessel lookups / month<br>
                    ✓ Class status &amp; survey dates<br>
                    ✓ IMO number search<br>
                    ✓ JSON responses
                  </p>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#475569;">
              Log in to your account to retrieve your API key and explore the full API reference.
            </p>
            <a href="https://vessel-class-finder-production.up.railway.app" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:600;">Get your API key →</a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              Questions? Reply to this email or check our <a href="https://vessel-class-finder-production.up.railway.app/#api" style="color:#3b82f6;text-decoration:none;">API docs</a>.
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
        console.error("Confirmation email failed:", e.message);
    }
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
app.post("/register", authLimiter, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        const result = await pool.query(
            "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
            [email, hashedPassword]
        );
        res.json({ message: "User registered", userId: result.rows[0].id });
        notifyTelegram(`New signup: ${email}`);
        sendConfirmationEmail(email);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "User already exists or database error" });
    }
});

// 📌 User Login & API Key Generation
app.post("/login", authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

        const user = result.rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign({ userId: user.id, email: user.email }, SECRET_KEY, { expiresIn: "7d" });

        // Generate an API key for the user
        const apiKey = uuidv4();
        await pool.query("INSERT INTO api_keys (user_id, api_key) VALUES ($1, $2)", [user.id, apiKey]);

        res.json({ message: "Login successful", token, apiKey });
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

// 📌 Middleware: Check Usage Limits
const PLAN_LIMITS = { free: 100, starter: 5000, pro: 50000, enterprise: Infinity };

const checkUsageLimit = async (req, res, next) => {
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

        const currentUsage = usageResult.rows.length > 0 ? usageResult.rows[0].request_count : 0;

        if (limit !== Infinity && currentUsage >= limit) {
            return res.status(429).json({
                error: "Monthly lookup limit reached. Upgrade your plan at info@wearefabbrik.com",
                usage: currentUsage,
                limit,
                plan
            });
        }

        await pool.query(
            "INSERT INTO api_usage (user_id, month, request_count) VALUES ($1, $2, 1) ON CONFLICT (user_id, month) DO UPDATE SET request_count = api_usage.request_count + 1",
            [req.userId, month]
        );

        req.plan = plan;
        req.usageCount = currentUsage + 1;
        req.usageLimit = limit;
        next();
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// 📌 API: Fetch Vessel Data by IMO
app.post("/vessels", authenticateAPIKey, checkUsageLimit, async (req, res) => {
    try {
        const { imos } = req.body;
        if (!imos || !Array.isArray(imos)) return res.status(400).json({ error: "Provide an array of IMOs" });

        const placeholders = imos.map((_, i) => `$${i + 1}`).join(",");
        const result = await pool.query(`SELECT * FROM vessel_data WHERE imo IN (${placeholders})`, imos);

        res.json(result.rows);
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

// 📌 API: Activate Subscription (Admin Use)
app.post("/subscribe", authenticateAPIKey, async (req, res) => {
    try {
        const { email } = req.body;
        const userResult = await pool.query("SELECT id FROM users WHERE email = $1", [email]);

        if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });

        const userId = userResult.rows[0].id;
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1); // 1-month subscription

        await pool.query(
            "INSERT INTO subscriptions (user_id, status, expires_at) VALUES ($1, 'active', $2) ON CONFLICT (user_id) DO UPDATE SET status = 'active', expires_at = $2",
            [userId, expiresAt]
        );

        res.json({ message: "Subscription activated" });
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

export { app, pool };

// 📌 Start Server
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "test") {
    app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
}