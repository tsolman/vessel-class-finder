import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ALL external modules BEFORE importing app.js
vi.mock("axios", () => ({ default: vi.fn() }));
vi.mock("cheerio", () => ({ load: vi.fn() }));
vi.mock("fs", () => ({
  default: {
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    readdirSync: vi.fn(),
  },
}));
vi.mock("fs-extra", () => ({
  default: { removeSync: vi.fn() },
}));
vi.mock("adm-zip", () => ({
  default: vi.fn().mockImplementation(() => ({
    extractAllTo: vi.fn(),
  })),
}));
vi.mock("csv-parser", () => ({
  default: vi.fn(),
}));
vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
}));
vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
}));

const mockClient = {
  query: vi.fn().mockResolvedValue({}),
  release: vi.fn(),
};

vi.mock("pg", () => {
  function Pool() {
    this.connect = vi.fn().mockResolvedValue(mockClient);
  }
  function Client() {}
  return { default: { Pool, Client } };
});

const { formatDate, extractShipNameAndDate, saveToDatabase, parseCsv, run } =
  await import("./app.js");

// ─── formatDate ─────────────────────────────────────────────────────────────
describe("formatDate", () => {
  it('converts "20230115" to "15/01/2023"', () => {
    expect(formatDate("20230115")).toBe("15/01/2023");
  });

  it("returns empty string for empty input", () => {
    expect(formatDate("")).toBe("");
  });

  it("returns empty string for null input", () => {
    expect(formatDate(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(formatDate(undefined)).toBe("");
  });

  it("returns empty string for wrong length input", () => {
    expect(formatDate("2023")).toBe("");
    expect(formatDate("202301151")).toBe("");
  });

  it("returns empty string for NaN input", () => {
    expect(formatDate("abcdefgh")).toBe("");
  });
});

// ─── extractShipNameAndDate ─────────────────────────────────────────────────
describe("extractShipNameAndDate", () => {
  it("extracts name and date from a name with a date suffix", () => {
    expect(extractShipNameAndDate("VESSEL NAME(01/02/23)")).toEqual({
      shipName: "VESSEL NAME",
      updateDate: "01/02/23",
    });
  });

  it("returns the name and empty date when no date is present", () => {
    expect(extractShipNameAndDate("VESSEL NAME")).toEqual({
      shipName: "VESSEL NAME",
      updateDate: "",
    });
  });

  it("trims extra spaces in the name", () => {
    expect(extractShipNameAndDate("  VESSEL  (01/02/23)")).toEqual({
      shipName: "VESSEL",
      updateDate: "01/02/23",
    });
  });
});

// ─── saveToDatabase ─────────────────────────────────────────────────────────
describe("saveToDatabase", () => {
  beforeEach(() => {
    mockClient.query.mockClear();
    mockClient.release.mockClear();
  });

  it("uses parameterized queries and the staging-table approach", async () => {
    const sampleData = [
      {
        imo: "1234567",
        ship_name: "TEST VESSEL",
        update_date: "01/01/23",
        class: "AB",
        date_of_survey: "01/01/2023",
        date_of_next_survey: "01/01/2024",
        date_of_latest_status: "01/01/2023",
        status: "Active",
        reason_for_status: "",
      },
      {
        imo: "7654321",
        ship_name: "ANOTHER VESSEL",
        update_date: "02/02/23",
        class: "CD",
        date_of_survey: "02/02/2023",
        date_of_next_survey: "02/02/2024",
        date_of_latest_status: "02/02/2023",
        status: "Inactive",
        reason_for_status: "Laid up",
      },
    ];

    await saveToDatabase(sampleData);

    const queryTexts = mockClient.query.mock.calls.map((c) => c[0]);

    // Staging table lifecycle
    expect(queryTexts.some((q) => typeof q === "string" && q.includes("BEGIN"))).toBe(true);
    expect(queryTexts.some((q) => typeof q === "string" && q.includes("CREATE TABLE IF NOT EXISTS vessel_data_staging"))).toBe(true);
    expect(queryTexts.some((q) => typeof q === "string" && q.includes("TRUNCATE vessel_data_staging"))).toBe(true);
    expect(queryTexts.some((q) => typeof q === "string" && q.includes("DROP TABLE IF EXISTS vessel_data"))).toBe(true);
    expect(queryTexts.some((q) => typeof q === "string" && q.includes("RENAME TO vessel_data"))).toBe(true);
    expect(queryTexts.some((q) => typeof q === "string" && q.includes("COMMIT"))).toBe(true);

    // Find the INSERT call — it has two arguments (query string + values array)
    const insertCall = mockClient.query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO vessel_data_staging")
    );
    expect(insertCall).toBeDefined();

    const [insertQuery, insertValues] = insertCall;

    // Parameterised placeholders ($1, $2, ...)
    expect(insertQuery).toMatch(/\$1/);
    expect(insertQuery).toMatch(/\$2/);
    expect(insertQuery).toMatch(/\$18/); // 2 records * 9 columns = 18

    // Values array contains actual data
    expect(insertValues).toContain("1234567");
    expect(insertValues).toContain("TEST VESSEL");
    expect(insertValues).toContain("7654321");
    expect(insertValues).toContain("ANOTHER VESSEL");
    expect(insertValues).toContain("Laid up");

    // Client is always released
    expect(mockClient.release).toHaveBeenCalled();
  });
});
