import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("pg", () => {
  const MockPool = vi.fn(function () {
    this.query = mockQuery;
  });
  return {
    default: { Pool: MockPool },
  };
});

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn(() => "hashed_password"),
    compare: vi.fn(() => true),
  },
}));

vi.mock("jsonwebtoken", () => ({
  default: {
    sign: vi.fn(() => "mock_token"),
    verify: vi.fn(() => ({ userId: 1 })),
  },
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-key"),
}));

vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
}));

vi.mock("express-rate-limit", () => ({
  default: vi.fn(() => (req, res, next) => next()),
}));

const { app } = await import("./server.js");
import request from "supertest";
import bcrypt from "bcryptjs";

const VALID_API_KEY = "test-api-key";

function mockAuthMiddleware() {
  mockQuery.mockResolvedValueOnce({
    rows: [{ user_id: 1 }],
  });
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe("POST /register", () => {
  it("should register a user successfully", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] });

    const res = await request(app)
      .post("/register")
      .send({ email: "captain@vesselmail.io", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(42);
    expect(res.body.message).toMatch(/verify/i);
    // User must be inserted as unverified with a token.
    const insertSql = mockQuery.mock.calls[0][0];
    expect(insertSql).toMatch(/verification_token/);
    expect(insertSql).toMatch(/FALSE/);
  });

  it("should return 400 when fields are missing", async () => {
    const res = await request(app).post("/register").send({ email: "" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing fields" });
  });

  it("should reject reserved/disposable email domains", async () => {
    const res = await request(app)
      .post("/register")
      .send({ email: "temp_user_x@example.com", password: "password123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-disposable/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should reject malformed email addresses", async () => {
    const res = await request(app)
      .post("/register")
      .send({ email: "notanemail", password: "password123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid email/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should silently reject bot submissions that fill the honeypot", async () => {
    const res = await request(app)
      .post("/register")
      .send({ email: "bot@vesselmail.io", password: "password123", website: "http://spam.example" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "User registered" });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should return 500 on database error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app)
      .post("/register")
      .send({ email: "captain@vesselmail.io", password: "password123" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "User already exists or database error",
    });
  });
});

describe("POST /login", () => {
  it("should login successfully and create an API key when the user has none", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, email: "test@example.com", password_hash: "hashed", verified: true }],
      })
      .mockResolvedValueOnce({ rows: [] }) // no active key
      .mockResolvedValueOnce({ rows: [] }); // insert

    const res = await request(app)
      .post("/login")
      .send({ email: "test@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: "Login successful",
      token: "mock_token",
      apiKey: "mock-uuid-key",
    });
    expect(mockQuery.mock.calls[2][0]).toMatch(/INSERT INTO api_keys/);
  });

  it("should reuse the existing active API key instead of minting a new one", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, email: "test@example.com", password_hash: "hashed", verified: true }],
      })
      .mockResolvedValueOnce({ rows: [{ api_key: "existing-key" }] });

    const res = await request(app)
      .post("/login")
      .send({ email: "test@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe("existing-key");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("should match emails case-insensitively", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, email: "test@example.com", password_hash: "hashed", verified: true }],
      })
      .mockResolvedValueOnce({ rows: [{ api_key: "existing-key" }] });

    const res = await request(app)
      .post("/login")
      .send({ email: "  Test@Example.COM ", password: "password123" });

    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[0][0]).toMatch(/lower\(email\)/);
    expect(mockQuery.mock.calls[0][1]).toEqual(["test@example.com"]);
  });

  it("should return 401 when email is not a string", async () => {
    const res = await request(app)
      .post("/login")
      .send({ email: { $ne: "" }, password: "password123" });

    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should block login for an unverified account", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, email: "test@example.com", password_hash: "hashed", verified: false }],
    });

    const res = await request(app)
      .post("/login")
      .send({ email: "test@example.com", password: "password123" });

    expect(res.status).toBe(403);
    expect(res.body.unverified).toBe(true);
    // No API key should be issued.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should return 401 for invalid email", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/login")
      .send({ email: "nobody@example.com", password: "password123" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
  });

  it("should return 401 for wrong password", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, email: "test@example.com", password_hash: "hashed" }],
    });
    bcrypt.compare.mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/login")
      .send({ email: "test@example.com", password: "wrongpassword" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid credentials" });
  });
});

describe("GET /verify", () => {
  it("should verify a valid, unexpired token and mark the user verified", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 7, verified: false, verification_sent_at: new Date().toISOString() }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = await request(app).get("/verify").query({ token: "good-token" });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/verified/i);
    const updateSql = mockQuery.mock.calls[1][0];
    expect(updateSql).toMatch(/verified = TRUE/);
  });

  it("should reject a missing token", async () => {
    const res = await request(app).get("/verify");
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should reject an unknown token", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/verify").query({ token: "nope" });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/invalid/i);
  });

  it("should reject an expired token without verifying", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 7, verified: false, verification_sent_at: eightDaysAgo }],
    });

    const res = await request(app).get("/verify").query({ token: "old-token" });

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/expired/i);
    // Only the SELECT ran — no UPDATE.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("POST /resend-verification", () => {
  it("should return a generic response and not leak account existence", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no such user
    const res = await request(app)
      .post("/resend-verification")
      .send({ email: "unknown@vesselmail.io" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that account exists/i);
  });

  it("should reject invalid/reserved emails with the same generic response", async () => {
    const res = await request(app)
      .post("/resend-verification")
      .send({ email: "bot@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that account exists/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// Helper: mock checkUsageLimit to pass (free user, under limit)
function mockUsageUnderLimit() {
  // subscription lookup — no subscription (free)
  mockQuery.mockResolvedValueOnce({ rows: [] });
  // usage lookup — 10 requests so far
  mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 10 }] });
  // usage UPSERT
  mockQuery.mockResolvedValueOnce({ rows: [] });
}

describe("POST /vessels", () => {
  it("should return vessel data for valid IMOs", async () => {
    const vesselData = [
      { imo: "1234567", name: "Test Vessel", class: "Tanker" },
    ];

    mockAuthMiddleware();
    mockUsageUnderLimit();
    mockQuery.mockResolvedValueOnce({ rows: vesselData });

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: ["1234567"] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(vesselData);
  });

  it("should return 400 when imos field is missing, without charging usage", async () => {
    mockAuthMiddleware();

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Provide an array of IMOs" });
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the API key lookup
  });

  it("should return 400 for an empty imos array", async () => {
    mockAuthMiddleware();

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: [] });

    expect(res.status).toBe(400);
  });

  it("should return 400 for non-numeric IMOs", async () => {
    mockAuthMiddleware();

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: ["1234567", "abc", "12345678"] });

    expect(res.status).toBe(400);
    expect(res.body.invalid).toEqual(["abc", "12345678"]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should return 400 when more than 100 unique IMOs are requested", async () => {
    mockAuthMiddleware();
    const imos = Array.from({ length: 101 }, (_, i) => 1000000 + i);

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/At most 100 IMOs/);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("should charge one lookup per unique IMO", async () => {
    mockAuthMiddleware();
    mockUsageUnderLimit();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: ["1234567", 1234567, "7654321", 9999999] });

    expect(res.status).toBe(200);
    const upsert = mockQuery.mock.calls[3];
    expect(upsert[0]).toMatch(/INSERT INTO api_usage/);
    expect(upsert[1][2]).toBe(3);
    expect(mockQuery.mock.calls[4][1]).toEqual([[1234567, 7654321, 9999999]]);
  });

  it("should return 429 when the request would exceed the remaining quota", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // free plan
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 98 }] });

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: [1111111, 2222222, 3333333] });

    expect(res.status).toBe(429);
    expect(res.body.usage).toBe(98);
    expect(res.body.requested).toBe(3);
  });

  it("should return 403 when no API key is provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/vessels").send({ imos: ["1234567"] });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "API key required" });
  });

  it("should return 429 when free tier limit is exceeded", async () => {
    mockAuthMiddleware();
    // subscription lookup — no subscription (free, limit 100)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // usage lookup — at limit
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 100 }] });

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: ["1234567"] });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Monthly lookup limit reached/);
    expect(res.body.usage).toBe(100);
    expect(res.body.limit).toBe(100);
    expect(res.body.plan).toBe("free");
  });

  it("should allow paid user with higher limit", async () => {
    const vesselData = [{ imo: "1234567", name: "Test Vessel" }];

    mockAuthMiddleware();
    // subscription lookup — active starter plan
    mockQuery.mockResolvedValueOnce({
      rows: [{ plan: "starter", status: "active", expires_at: new Date(Date.now() + 86400000).toISOString() }],
    });
    // usage lookup — 200 requests (over free limit but under starter)
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 200 }] });
    // usage UPSERT
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // vessel query
    mockQuery.mockResolvedValueOnce({ rows: vesselData });

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: ["1234567"] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(vesselData);
  });
});

describe("GET /usage", () => {
  it("should return usage for free user", async () => {
    mockAuthMiddleware();
    // subscription lookup — none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // usage lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 42 }] });

    const res = await request(app)
      .get("/usage")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.used).toBe(42);
    expect(res.body.limit).toBe(100);
    expect(res.body.plan).toBe("free");
    expect(res.body.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("should return usage for paid user", async () => {
    mockAuthMiddleware();
    // subscription lookup — active pro plan
    mockQuery.mockResolvedValueOnce({
      rows: [{ plan: "pro", status: "active", expires_at: new Date(Date.now() + 86400000).toISOString() }],
    });
    // usage lookup
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 1500 }] });

    const res = await request(app)
      .get("/usage")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.used).toBe(1500);
    expect(res.body.limit).toBe(50000);
    expect(res.body.plan).toBe("pro");
  });
});

describe("GET /subscription", () => {
  it("should return active subscription status", async () => {
    const subscription = { status: "active", expires_at: "2026-12-31" };

    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [subscription] });

    const res = await request(app)
      .get("/subscription")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(subscription);
  });

  it("should return inactive when no subscription exists", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/subscription")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "inactive" });
  });
});

describe("POST /subscribe", () => {
  const ADMIN_KEY = "test-admin-key";

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("should activate subscription with the admin key", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/subscribe")
      .set("x-admin-key", ADMIN_KEY)
      .send({ email: "Test@Example.com", plan: "pro" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Subscription activated");
    expect(res.body.plan).toBe("pro");
    expect(mockQuery.mock.calls[0][1]).toEqual(["test@example.com"]);
    expect(mockQuery.mock.calls[1][1][2]).toBe("pro");
  });

  it("should default to the starter plan", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/subscribe")
      .set("x-admin-key", ADMIN_KEY)
      .send({ email: "test@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe("starter");
  });

  it("should reject a regular user API key", async () => {
    const res = await request(app)
      .post("/subscribe")
      .set("x-api-key", VALID_API_KEY)
      .send({ email: "test@example.com" });

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should reject a wrong admin key", async () => {
    const res = await request(app)
      .post("/subscribe")
      .set("x-admin-key", "wrong-key")
      .send({ email: "test@example.com" });

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should be disabled when ADMIN_API_KEY is not set", async () => {
    delete process.env.ADMIN_API_KEY;

    const res = await request(app)
      .post("/subscribe")
      .set("x-admin-key", "")
      .send({ email: "test@example.com" });

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should reject an unknown plan", async () => {
    const res = await request(app)
      .post("/subscribe")
      .set("x-admin-key", ADMIN_KEY)
      .send({ email: "test@example.com", plan: "free" });

    expect(res.status).toBe(400);
  });

  it("should return 404 when user is not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/subscribe")
      .set("x-admin-key", ADMIN_KEY)
      .send({ email: "nonexistent@example.com" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "User not found" });
  });
});

describe("GET /api-keys", () => {
  it("should return list of API keys", async () => {
    const keys = [
      { api_key: "key-1", active: true, created_at: "2026-01-01" },
      { api_key: "key-2", active: false, created_at: "2025-12-01" },
    ];

    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: keys });

    const res = await request(app)
      .get("/api-keys")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(keys);
  });
});

describe("DELETE /api-keys/:key", () => {
  it("should revoke an API key successfully", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [{ api_key: "key-to-revoke" }] });

    const res = await request(app)
      .delete("/api-keys/key-to-revoke")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "API key revoked" });
  });

  it("should return 404 when key is not found", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete("/api-keys/nonexistent-key")
      .set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "API key not found or already revoked",
    });
  });
});
