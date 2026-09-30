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

const mockSendEmail = vi.fn(() => Promise.resolve({}));
vi.mock("resend", () => ({
  Resend: vi.fn(function () {
    this.emails = { send: mockSendEmail };
  }),
}));

const mockStripe = {
  checkout: { sessions: { create: vi.fn() } },
  billingPortal: { sessions: { create: vi.fn() } },
  subscriptions: { retrieve: vi.fn() },
  webhooks: { constructEvent: vi.fn() },
};
vi.mock("stripe", () => ({
  default: vi.fn(function () {
    return mockStripe;
  }),
}));

process.env.RESEND_API_KEY = "re_test";
process.env.STRIPE_SECRET_KEY = "sk_test";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_PRICE_STARTER = "price_starter";
process.env.STRIPE_PRICE_PRO = "price_pro";

const { app, pruneOldUsage } = await import("./server.js");
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
  mockSendEmail.mockClear();
  for (const fn of [
    mockStripe.checkout.sessions.create,
    mockStripe.billingPortal.sessions.create,
    mockStripe.subscriptions.retrieve,
    mockStripe.webhooks.constructEvent,
  ]) fn.mockReset();
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
  // atomic check-and-charge UPSERT — succeeded, now at 11
  mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 11 }] });
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
    const upsert = mockQuery.mock.calls[2];
    expect(upsert[0]).toMatch(/INSERT INTO api_usage/);
    expect(upsert[1][2]).toBe(3); // cost
    expect(upsert[1][3]).toBe(100); // free-tier limit enforced in SQL
    expect(mockQuery.mock.calls[3][1]).toEqual([[1234567, 7654321, 9999999]]);
  });

  it("should return 429 when the request would exceed the remaining quota", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // free plan
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPSERT refused: over limit
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 98 }] }); // current usage for the error

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
    // UPSERT refused: at limit
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // current usage for the error body
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 100 }] });

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: ["1234567"] });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Monthly lookup limit reached/);
    expect(res.body.upgrade_url).toBe("https://vesselclassfinder.com/#pricing");
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
    // UPSERT succeeds — 201 lookups (over free limit but under starter)
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 201 }] });
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

describe("pruneOldUsage", () => {
  it("deletes usage rows older than the 12-month retention window", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 3 });

    await pruneOldUsage();

    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM api_usage WHERE month </);
    expect(mockQuery.mock.calls[0][1]).toEqual([12]);
  });

  it("never throws when the database errors", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(pruneOldUsage()).resolves.toBeUndefined();
  });
});

describe("usage alert emails", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("emails once when a request crosses 80% of the plan", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // free plan
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 81 }] }); // 79 -> 81 crosses 80
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "captain@vesselmail.io" }] }); // flag claimed
    mockQuery.mockResolvedValueOnce({ rows: [] }); // vessel query

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: [1234567, 7654321] });
    await flush();

    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[3][0]).toMatch(/SET warned_80 = TRUE/);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe("captain@vesselmail.io");
    expect(mockSendEmail.mock.calls[0][0].subject).toMatch(/80%/);
  });

  it("doesn't email when this month's alert was already sent", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 81 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // flag already set
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).post("/vessels").set("x-api-key", VALID_API_KEY).send({ imos: [1234567, 7654321] });
    await flush();

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("doesn't email below the threshold", async () => {
    mockAuthMiddleware();
    mockUsageUnderLimit();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).post("/vessels").set("x-api-key", VALID_API_KEY).send({ imos: [1234567] });
    await flush();

    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("doesn't send the 100% alert when a batch is refused but quota remains", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // refused: 20 IMOs don't fit
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 90 }] });

    const imos = Array.from({ length: 20 }, (_, i) => 1000000 + i);
    const res = await request(app).post("/vessels").set("x-api-key", VALID_API_KEY).send({ imos });
    await flush();

    expect(res.status).toBe(429);
    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends the 100% alert when a request is refused", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // refused
    mockQuery.mockResolvedValueOnce({ rows: [{ request_count: 100 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "captain@vesselmail.io" }] });

    const res = await request(app).post("/vessels").set("x-api-key", VALID_API_KEY).send({ imos: [1234567] });
    await flush();

    expect(res.status).toBe(429);
    expect(mockQuery.mock.calls[4][0]).toMatch(/SET warned_100 = TRUE/);
    expect(mockSendEmail.mock.calls[0][0].html).toMatch(/#pricing/);
  });
});

describe("POST /billing/checkout", () => {
  it("creates a Stripe Checkout session for the chosen plan", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "captain@vesselmail.io", stripe_customer_id: null, stripe_subscription_id: null, status: null }] });
    mockStripe.checkout.sessions.create.mockResolvedValueOnce({ url: "https://checkout.stripe.com/c/pay/cs_test" });

    const res = await request(app)
      .post("/billing/checkout")
      .set("x-api-key", VALID_API_KEY)
      .send({ plan: "pro" });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.stripe.com/c/pay/cs_test");
    const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([{ price: "price_pro", quantity: 1 }]);
    expect(params.customer_email).toBe("captain@vesselmail.io");
    expect(params.subscription_data.metadata.userId).toBe("1");
  });

  it("reuses an existing Stripe customer", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "captain@vesselmail.io", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_old", status: "inactive", expires_at: new Date(Date.now() - 86400000).toISOString() }] });
    mockStripe.checkout.sessions.create.mockResolvedValueOnce({ url: "https://checkout.stripe.com/x" });

    await request(app).post("/billing/checkout").set("x-api-key", VALID_API_KEY).send({ plan: "starter" });

    const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.customer).toBe("cus_1");
    expect(params.customer_email).toBeUndefined();
  });

  it("rejects unknown plans", async () => {
    mockAuthMiddleware();
    const res = await request(app).post("/billing/checkout").set("x-api-key", VALID_API_KEY).send({ plan: "enterprise" });
    expect(res.status).toBe(400);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("sends active subscribers to the billing portal instead", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "captain@vesselmail.io", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status: "active", expires_at: new Date(Date.now() + 86400000).toISOString() }] });

    const res = await request(app).post("/billing/checkout").set("x-api-key", VALID_API_KEY).send({ plan: "pro" });

    expect(res.status).toBe(409);
    expect(res.body.portal).toBe(true);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("blocks checkout for plans granted by hand, without offering the portal", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "captain@vesselmail.io", stripe_customer_id: null, stripe_subscription_id: null, status: "active", expires_at: new Date(Date.now() + 86400000).toISOString() }] });

    const res = await request(app).post("/billing/checkout").set("x-api-key", VALID_API_KEY).send({ plan: "starter" });

    expect(res.status).toBe(409);
    expect(res.body.portal).toBeUndefined();
    expect(res.body.error).toMatch(/managed by our team/);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("allows checkout once a hand-granted plan has expired", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [{ email: "captain@vesselmail.io", stripe_customer_id: null, stripe_subscription_id: null, status: "active", expires_at: new Date(Date.now() - 86400000).toISOString() }] });
    mockStripe.checkout.sessions.create.mockResolvedValueOnce({ url: "https://checkout.stripe.com/x" });

    const res = await request(app).post("/billing/checkout").set("x-api-key", VALID_API_KEY).send({ plan: "starter" });

    expect(res.status).toBe(200);
  });
});

describe("POST /billing/portal", () => {
  it("opens the portal for a customer", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [{ stripe_customer_id: "cus_1" }] });
    mockStripe.billingPortal.sessions.create.mockResolvedValueOnce({ url: "https://billing.stripe.com/p/session" });

    const res = await request(app).post("/billing/portal").set("x-api-key", VALID_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://billing.stripe.com/p/session");
    expect(mockStripe.billingPortal.sessions.create.mock.calls[0][0].customer).toBe("cus_1");
  });

  it("returns 404 for users who never subscribed", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/billing/portal").set("x-api-key", VALID_API_KEY);
    expect(res.status).toBe(404);
  });
});

describe("POST /billing/webhook", () => {
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  const subscription = (overrides = {}) => ({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    metadata: { userId: "user-uuid" },
    items: { data: [{ price: { id: "price_starter" }, current_period_end: periodEnd }] },
    ...overrides,
  });

  function postEvent(event) {
    mockStripe.webhooks.constructEvent.mockReturnValueOnce(event);
    return request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "t=1,v1=sig")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(event));
  }

  it("rejects requests with a bad signature", async () => {
    mockStripe.webhooks.constructEvent.mockImplementationOnce(() => { throw new Error("bad sig"); });
    const res = await request(app).post("/billing/webhook").set("Content-Type", "application/json").send("{}");
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("verifies the signature against the raw body", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(subscription());
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await postEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
    const [body, sig, secret] = mockStripe.webhooks.constructEvent.mock.calls[0];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(sig).toBe("t=1,v1=sig");
    expect(secret).toBe("whsec_test");
  });

  it("activates the plan when checkout completes", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(subscription());
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await postEvent({ type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1" } } });

    expect(res.status).toBe(200);
    expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO subscriptions/);
    expect(params[0]).toBe("user-uuid");
    expect(params[1]).toBe("active");
    expect(params[2].getTime()).toBeGreaterThan(periodEnd * 1000); // period end plus grace
    expect(params.slice(3)).toEqual(["starter", "cus_1", "sub_1", true]);
  });

  it("maps the Pro price to the pro plan on upgrade", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription({ items: { data: [{ price: { id: "price_pro" }, current_period_end: periodEnd }] } })
    );
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await postEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
    expect(mockQuery.mock.calls[0][1][3]).toBe("pro");
  });

  it("downgrades to free when the subscription ends", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(subscription({ status: "canceled" }));
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await postEvent({ type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBe("inactive"); // DB CHECK allows only active/inactive
    expect(params[2].getTime()).toBeLessThanOrEqual(Date.now());
    // An ended subscription only updates the row if it's the one on record (or none is).
    expect(sql).toMatch(/WHERE \$7 OR subscriptions.stripe_subscription_id IS NULL OR subscriptions.stripe_subscription_id = \$6/);
    expect(params[6]).toBe(false);
  });

  it("lets a live subscription replace whatever is on the row", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(subscription({ id: "sub_new" }));
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await postEvent({ type: "customer.subscription.created", data: { object: { id: "sub_new" } } });
    expect(mockQuery.mock.calls[0][1][6]).toBe(true);
  });

  it("acknowledges events for users that no longer exist", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(subscription());
    mockQuery.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "23503", detail: "user missing" }));
    const res = await postEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
    expect(res.status).toBe(200);
  });

  it("ignores unrelated events", async () => {
    const res = await postEvent({ type: "invoice.created", data: { object: {} } });
    expect(res.status).toBe(200);
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 500 so Stripe retries when the database fails", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValueOnce(subscription());
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    const res = await postEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
    expect(res.status).toBe(500);
  });
});

describe("GET /demo/:imo", () => {
  it("returns one vessel without an API key", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ imo: 9200079, vessel_name: "NORDIC AURORA", class: "DNV" }] });
    const res = await request(app).get("/demo/9200079");
    expect(res.status).toBe(200);
    expect(res.body.class).toBe("DNV");
    expect(mockQuery.mock.calls[0][1]).toEqual([9200079]);
  });

  it("rejects malformed IMO numbers without querying", async () => {
    const res = await request(app).get("/demo/12ab");
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown vessels", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/demo/1234567");
    expect(res.status).toBe(404);
  });
});
