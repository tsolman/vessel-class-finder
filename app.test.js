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

const { formatDate, extractShipNameAndDate, findZipLinksInPayload, pickLatestRecords, saveToDatabase, parseCsv, run } =
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

// ─── findZipLinksInPayload ──────────────────────────────────────────────────
describe("findZipLinksInPayload", () => {
  it("finds escaped zip URLs in serialized page data with their version", () => {
    const html =
      '<script>window.__NUXT__={download_items:[{file:"https:\\u002F\\u002Fiacs.s3.af-south-1.amazonaws.com\\u002Fwp-content\\u002Fuploads\\u002F2026\\u002F09\\u002F18110306\\u002FEquasisToIACS_20260918_976.zip"},' +
      '{file:"https://iacs.s3.af-south-1.amazonaws.com/wp-content/uploads/2026/09/11150648/EquasisToIACS_20260911_975.zip"}]}</script>';
    const links = findZipLinksInPayload(html);
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({
      url: "https://iacs.s3.af-south-1.amazonaws.com/wp-content/uploads/2026/09/18110306/EquasisToIACS_20260918_976.zip",
      version: 976,
    });
    expect(links.map((l) => l.version)).toContain(975);
  });

  it("returns an empty list when there are no zip links", () => {
    expect(findZipLinksInPayload("<html><a href='/file.pdf'>Download File</a></html>")).toEqual([]);
    expect(findZipLinksInPayload(undefined)).toEqual([]);
  });

  it("deduplicates repeated URLs", () => {
    const url = "https://iacs.org.uk/files/EquasisToIACS_20260918_976.zip";
    expect(findZipLinksInPayload(`"${url}" "${url}"`)).toEqual([{ url, version: 976 }]);
  });
});

// ─── pickLatestRecords ──────────────────────────────────────────────────────
describe("pickLatestRecords", () => {
  const row = (overrides = {}) => ({
    imo: "9290361",
    ship_name: "SEAOATH",
    update_date: "12/02/25",
    class: "ABS",
    date_of_survey: "08/02/2020",
    date_of_next_survey: "02/02/2025",
    date_of_latest_status: "31/03/2005",
    status: "Delivered",
    reason_for_status: "",
    ...overrides,
  });

  it("keeps the newest survey cycle instead of the first row", () => {
    const newer = row({ update_date: "10/09/26", date_of_survey: "12/02/2025", date_of_next_survey: "02/02/2030" });
    expect(pickLatestRecords([row(), newer])).toEqual([newer]);
  });

  it("keeps the new society's record after a class transfer", () => {
    const withdrawn = row({ update_date: "10/09/26", status: "Withdrawn", reason_for_status: "Change of class" });
    const newClass = row({ update_date: "10/09/26", class: "LRS", date_of_latest_status: "01/09/2026" });
    expect(pickLatestRecords([withdrawn, newClass])).toEqual([newClass]);
    expect(pickLatestRecords([newClass, withdrawn])).toEqual([newClass]);
  });

  it("reports a withdrawal when it is the newest information", () => {
    const withdrawn = row({ update_date: "10/09/26", status: "Withdrawn" });
    expect(pickLatestRecords([row(), withdrawn])).toEqual([withdrawn]);
  });

  it("falls back to the survey date when row stamps are equal or missing", () => {
    const older = row({ update_date: "", date_of_survey: "08/02/2020" });
    const newer = row({ update_date: "", date_of_survey: "12/02/2025" });
    expect(pickLatestRecords([newer, older])).toEqual([newer]);
  });

  it("skips records without IMO or ship name and keeps one record per IMO", () => {
    const result = pickLatestRecords([
      row({ imo: "" }),
      row({ ship_name: "" }),
      row({ imo: "1111111" }),
      row(),
      row({ date_of_survey: "01/01/2019" }),
    ]);
    expect(result.map((r) => r.imo)).toEqual(["1111111", "9290361"]);
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
