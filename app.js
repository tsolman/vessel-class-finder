import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import pkg from 'pg';
import AdmZip from "adm-zip";
import dotenv from "dotenv";
import fsExtra from "fs-extra";
import csvParser from "csv-parser"; // CSV parsing module
import { performance } from "perf_hooks";
import cron from "node-cron";

const { Pool, Client } = pkg;
dotenv.config({ path: "./.env.local" });

// PostgreSQL Connection
const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// Function to scrape and get the latest Equasis CSV file URL
async function getLatestEquasisFileUrl() {
    try {
        const response = await axios.get("https://iacs.org.uk/membership/vessels-in-class");
        const $ = cheerio.load(response.data);

        let fileLinks = [];

        $("a").each((index, element) => {
            const text = $(element).text().trim().toLowerCase();
            const link = $(element).attr("href");

            if (text.includes("download file") && link.endsWith(".zip")) {
                const match = link.match(/_(\d+)\.zip$/); // Extract number at the end
                if (match) {
                    fileLinks.push({ url: link.startsWith("http") ? link : "https://iacs.org.uk" + link, version: parseInt(match[1], 10) });
                }
            }
        });

        if (fileLinks.length === 0) {
            throw new Error("❌ No Equasis Data file found.");
        }

        // Sort by version number and pick the latest
        fileLinks.sort((a, b) => b.version - a.version);
        const latestFile = fileLinks[0];

        console.log(`✅ Found latest Equasis Data URL: ${latestFile.url}`);
        return latestFile.url;
    } catch (error) {
        console.error("❌ Error scraping page:", error.message);
        return null;
    }
}

// Function to download the ZIP file
async function downloadFile(url, outputPath) {
    try {
        const response = await axios({
            method: "GET",
            url,
            responseType: "stream",
        });

        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
        });
    } catch (error) {
        console.error("❌ Error downloading file:", error.message);
    }
}

// Function to extract ZIP and find the CSV file
async function extractZip(zipPath, outputDir) {
    try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(outputDir, true);
        console.log(`✅ Extracted ZIP to: ${outputDir}`);

        // Find the extracted CSV file
        const files = fs.readdirSync(outputDir);
        const csvFile = files.find((file) => file.endsWith(".csv"));

        if (!csvFile) {
            throw new Error("❌ No CSV file found in ZIP.");
        }

        return path.join(outputDir, csvFile);
    } catch (error) {
        console.error("❌ Error extracting ZIP file:", error.message);
        return null;
    }
}

// Function to format date (YYYYMMDD -> DD/MM/YYYY)
function formatDate(yyyymmdd) {
    if (!yyyymmdd || isNaN(yyyymmdd) || String(yyyymmdd).length !== 8) return "";
    return `${yyyymmdd.slice(6, 8)}/${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(0, 4)}`;
}

// Function to extract ship name and update date
function extractShipNameAndDate(shipName) {
    const match = shipName.match(/(.*)\((\d{2}\/\d{2}\/\d{2})\)/);
    if (match) return { shipName: match[1].trim(), updateDate: match[2] };
    return { shipName: shipName.trim(), updateDate: "" };
}

// Function to parse CSV data
async function parseCsv(filePath) {
    return new Promise((resolve, reject) => {
        const parsedData = [];

        fs.createReadStream(filePath)
            .pipe(csvParser({ separator: ";" })) // Define CSV separator
            .on("data", (row) => {
                const { shipName, updateDate } = extractShipNameAndDate(row["SHIP NAME"]);

                parsedData.push({
                    imo: row["IMO"],
                    ship_name: shipName,
                    update_date: updateDate,
                    class: row["CLASS"],
                    date_of_survey: formatDate(row["DATE OF SURVEY"]),
                    date_of_next_survey: formatDate(row["DATE OF NEXT SURVEY"]),
                    date_of_latest_status: formatDate(row["DATE OF LATEST STATUS"]),
                    status: row["STATUS"],
                    reason_for_status: row["REASON FOR THE STATUS"] || "",
                });
            })
            .on("end", () => resolve(parsedData))
            .on("error", reject);
    });
}

// Function to save data into PostgreSQL
async function saveToDatabase(data) {
    const client = await pool.connect();
    const batchSize = 500; // Insert 500 records at a time

    try {
        console.log(`🚀 Deduplicating data before inserting...`);

        // **Step 1: Remove duplicate IMO values and filter out invalid records**
        const uniqueData = [];
        const seenImos = new Set();

        for (const vessel of data) {
            if (!vessel.imo || !vessel.ship_name) continue; // Skip records with missing IMO or vessel name
            if (!seenImos.has(vessel.imo)) {
                seenImos.add(vessel.imo);
                uniqueData.push(vessel);
            }
        }

        console.log(`✅ Deduplicated and filtered records. Remaining: ${uniqueData.length}`);

        console.log(`🚀 Preparing staging table before inserting new records...`);
        await client.query("BEGIN");

        await client.query(`
      CREATE TABLE IF NOT EXISTS vessel_data_staging (
        imo BIGINT PRIMARY KEY,
        vessel_name TEXT NOT NULL,
        update_date TEXT,
        class TEXT,
        date_of_survey TEXT,
        date_of_next_survey TEXT,
        date_of_latest_status TEXT,
        status TEXT,
        reason_for_status TEXT
      );
    `);
        await client.query("TRUNCATE vessel_data_staging;");

        console.log(`🚀 Inserting ${uniqueData.length} records in batches...`);

        for (let i = 0; i < uniqueData.length; i += batchSize) {
            let batch = uniqueData.slice(i, i + batchSize);

            const values = [];
            const placeholders = batch.map((vessel, j) => {
                const offset = j * 9;
                values.push(vessel.imo, vessel.ship_name, vessel.update_date, vessel.class, vessel.date_of_survey, vessel.date_of_next_survey, vessel.date_of_latest_status, vessel.status, vessel.reason_for_status);
                return `($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8}, $${offset+9})`;
            });

            await client.query(`
        INSERT INTO vessel_data_staging
          (imo, vessel_name, update_date, class, date_of_survey, date_of_next_survey, date_of_latest_status, status, reason_for_status)
        VALUES ${placeholders.join(",")};
      `, values);

            console.log(`✅ Inserted batch ${Math.ceil(i / batchSize) + 1}/${Math.ceil(uniqueData.length / batchSize)}`);
        }

        console.log(`🚀 Creating indexes for better performance...`);
        await client.query(`
      CREATE INDEX idx_staging_vessel_name ON vessel_data_staging(vessel_name);
    `);

        await client.query("DROP TABLE IF EXISTS vessel_data CASCADE;");
        await client.query("ALTER TABLE vessel_data_staging RENAME TO vessel_data;");
        await client.query("ALTER INDEX idx_staging_vessel_name RENAME TO idx_vessel_name;");

        await client.query("COMMIT;");
        console.log(`✅ Successfully saved ${uniqueData.length} records to the database.`);
    } catch (error) {
        await client.query("ROLLBACK;"); // Rollback in case of error
        console.error("❌ Error saving to database:", error.message);
    } finally {
        client.release();
    }
}

// Function to clean up downloaded and extracted files
async function cleanupFiles(zipPath, extractDir) {
    try {
        fsExtra.removeSync(zipPath);
        fsExtra.removeSync(extractDir);
        console.log("✅ Cleaned up all temporary files.");
    } catch (error) {
        console.error("❌ Error cleaning up files:", error.message);
    }
}

// Main function to execute all steps
async function run() {
    const zipPath = "./equasis_data.zip";
    const extractDir = "./equasis_extracted";
    const start = performance.now();
    console.log("🚀 Starting Equasis Scraper...");
    const equasisUrl = await getLatestEquasisFileUrl();
    if (!equasisUrl) return;

    await downloadFile(equasisUrl, zipPath);
    const extractedCsvFile = await extractZip(zipPath, extractDir);

    if (extractedCsvFile) {
        const parsedData = await parseCsv(extractedCsvFile);
        console.log(`📊 Parsed ${parsedData.length} records from CSV.`);

        await saveToDatabase(parsedData);
        await cleanupFiles(zipPath, extractDir);
    }
    const end = performance.now();
    console.log(`Finished class finder process!  (${((end - start) / 1000).toFixed(1)}s)`);

}

export { formatDate, extractShipNameAndDate, saveToDatabase, parseCsv, run };

// Execute the scraper immediately on startup
if (process.env.NODE_ENV !== "test") run();

// Schedule weekly refresh: every Sunday at 2:00 AM
if (process.env.NODE_ENV !== "test") {
    cron.schedule("0 2 * * 0", () => {
        console.log("🕐 Scheduled data refresh starting...");
        run();
    });
}