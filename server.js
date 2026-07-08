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
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Public URL of this API (where the /verify link points) and of the marketing site.
const APP_URL = (process.env.APP_URL || "https://vessel-class-finder-production.up.railway.app").replace(/\/$/, "");
const SITE_URL = (process.env.SITE_URL || "https://tsolman.github.io/vessel-class-finder").replace(/\/$/, "");

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
        notifyTelegram(`New signup (pending verification): ${normalizedEmail}`);
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
            "SELECT id, verified FROM users WHERE email = $1",
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
        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

        const user = result.rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) return res.status(401).json({ error: "Invalid credentials" });

        if (user.verified === false) {
            return res.status(403).json({ error: "Please verify your email before logging in. Check your inbox for the verification link.", unverified: true });
        }

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
    runMigrations().finally(() => {
        app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
    });
}