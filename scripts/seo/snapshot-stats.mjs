// Snapshots fleet statistics from vessel_data into scripts/seo/stats.json, which
// build.mjs turns into the static SEO pages. Read-only; run after a data refresh:
//   node scripts/seo/snapshot-stats.mjs && node scripts/seo/build.mjs
import fs from "fs";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config({ path: "./.env.local" });
const pool = new pkg.Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.DB_PORT,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

const byClassStatus = await pool.query(
    "SELECT class, COALESCE(status, 'None') AS status, count(*)::int AS n FROM vessel_data GROUP BY 1, 2"
);
const reasons = await pool.query(
    `SELECT class, reason_for_status AS reason, count(*)::int AS n FROM vessel_data
     WHERE reason_for_status <> '' GROUP BY 1, 2 ORDER BY 1, 3 DESC`
);

const societies = {};
for (const { class: code, status, n } of byClassStatus.rows) {
    societies[code] ??= { total: 0, statuses: {}, reasons: [] };
    societies[code].total += n;
    societies[code].statuses[status] = n;
}
for (const { class: code, reason, n } of reasons.rows) {
    societies[code].reasons.push({ reason, n });
}

const totals = { total: 0, statuses: {}, reasons: {} };
for (const s of Object.values(societies)) {
    totals.total += s.total;
    for (const [status, n] of Object.entries(s.statuses)) totals.statuses[status] = (totals.statuses[status] || 0) + n;
    for (const { reason, n } of s.reasons) totals.reasons[reason] = (totals.reasons[reason] || 0) + n;
}

const out = { asOf: new Date().toISOString().slice(0, 10), totals, societies };
fs.writeFileSync(new URL("./stats.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote stats for ${Object.keys(societies).length} societies, ${totals.total} vessels (as of ${out.asOf})`);
await pool.end();
