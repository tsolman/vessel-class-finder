import { describe, it, expect, vi, beforeEach } from "vitest";

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
      .send({ email: "test@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "User registered", userId: 42 });
  });

  it("should return 400 when fields are missing", async () => {
    const res = await request(app).post("/register").send({ email: "" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Missing fields" });
  });

  it("should return 500 on database error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app)
      .post("/register")
      .send({ email: "test@example.com", password: "password123" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "User already exists or database error",
    });
  });
});

describe("POST /login", () => {
  it("should login successfully and return token and apiKey", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, email: "test@example.com", password_hash: "hashed" }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/login")
      .send({ email: "test@example.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: "Login successful",
      token: "mock_token",
      apiKey: "mock-uuid-key",
    });
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

describe("POST /vessels", () => {
  it("should return vessel data for valid IMOs", async () => {
    const vesselData = [
      { imo: "1234567", name: "Test Vessel", class: "Tanker" },
    ];

    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: vesselData });

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({ imos: ["1234567"] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(vesselData);
  });

  it("should return 400 when imos field is missing", async () => {
    mockAuthMiddleware();

    const res = await request(app)
      .post("/vessels")
      .set("x-api-key", VALID_API_KEY)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Provide an array of IMOs" });
  });

  it("should return 403 when no API key is provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/vessels").send({ imos: ["1234567"] });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "API key required" });
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
  it("should activate subscription successfully", async () => {
    mockAuthMiddleware();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/subscribe")
      .set("x-api-key", VALID_API_KEY)
      .send({ email: "test@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Subscription activated" });
  });

  it("should return 404 when user is not found", async () => {
    mockAuthMiddleware();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/subscribe")
      .set("x-api-key", VALID_API_KEY)
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
