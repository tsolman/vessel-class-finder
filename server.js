import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import pkg from 'pg';

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

const SECRET_KEY = process.env.JWT_SECRET; // JWT secret for authentication

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