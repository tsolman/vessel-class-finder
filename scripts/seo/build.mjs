// Generates the static SEO pages under docs/ from stats.json (fleet numbers),
// societies.json (society facts) and use-cases.json (use-case copy), and rewrites
// docs/sitemap.xml. Run: node scripts/seo/build.mjs
import fs from "fs";
import path from "path";

const ROOT = new URL("../../", import.meta.url).pathname;
const DOCS = path.join(ROOT, "docs");
const SITE = "https://vesselclassfinder.com";
const API = "https://vessel-class-finder-production.up.railway.app";

const read = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), "utf8"));
const stats = read("./stats.json");
const societies = read("./societies.json");
const useCases = fs.existsSync(new URL("./use-cases.json", import.meta.url)) ? read("./use-cases.json") : [];

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (n, total) => (total ? ((100 * n) / total).toFixed(1) : "0.0") + "%";
const asOfLong = new Date(stats.asOf + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const IN_CLASS = ["Delivered", "Reinstated", "Reassigned"];
const inClass = (s) => IN_CLASS.reduce((sum, k) => sum + (s.statuses[k] || 0), 0);

// Status meanings, hedged to what the IACS dataset records.
const STATUSES = [
    { key: "Delivered", slug: "delivered", inClass: true,
      short: "In class. The ship entered this society's class and has had no later suspension or withdrawal.",
      long: "The normal in-class status. The ship entered this society's class (typically on delivery as a newbuilding, or on transfer from another society) and no suspension or withdrawal has been recorded since." },
    { key: "Reinstated", slug: "reinstated", inClass: true,
      short: "In class again after a suspension.",
      long: "Class was suspended at some point (for example for an overdue survey) and has since been reinstated once the society's requirements were met. The ship is in class." },
    { key: "Reassigned", slug: "reassigned", inClass: true,
      short: "Class assigned again after a withdrawal or transfer.",
      long: "The ship had class withdrawn or transferred and was later assigned class again. The ship is in class; the history is worth a look in due diligence." },
    { key: "Suspended", slug: "suspended", inClass: false,
      short: "Class temporarily not valid until the society's requirements are met.",
      long: "Class is temporarily invalid, most often because a survey is overdue or a condition of class was not dealt with in time. Until it is reinstated the ship should be treated as not in class, which typically matters for insurance, charter parties and port state control." },
    { key: "Withdrawn", slug: "withdrawn", inClass: false,
      short: "No longer classed by this society.",
      long: "The society no longer classes the ship. Reasons range from routine (transfer to another IACS member, sale for recycling) to red flags (transfer to a non-IACS society, non-compliance, owner's request with no new class)." },
];

// ---------- layout ----------
function page({ urlPath, title, description, h1, breadcrumb, body, jsonld = [], wide = false }) {
    const url = SITE + urlPath;
    const crumbs = [{ name: "Home", path: "/" }, ...breadcrumb];
    const breadcrumbLd = {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: SITE + (c.path || urlPath) })),
    };
    const ld = [breadcrumbLd, ...jsonld].map((o) => `  <script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n  </script>`).join("\n");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <link rel="icon" href="/logo.svg" type="image/svg+xml">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Vessel Class Finder">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${url}">
  <meta name="twitter:card" content="summary">
  <link rel="stylesheet" href="/seo.css">
  <script src="/analytics.js"></script>
${ld}
</head>
<body>

<nav>
  <div class="nav-inner">
    <a href="/" class="logo">vessel<span>class</span>finder</a>
    <ul>
      <li class="nav-secondary"><a href="/class-societies/">Class societies</a></li>
      <li class="nav-secondary"><a href="/iacs-class-status-codes.html">Status codes</a></li>
      <li><a href="/#api">API</a></li>
      <li><a href="/#pricing">Pricing</a></li>
      <li><a href="/#signup" class="nav-account">Get API key</a></li>
    </ul>
  </div>
</nav>

<article${wide ? ' class="wide"' : ""}>
  <div class="breadcrumb">
    ${crumbs.map((c, i) => (i < crumbs.length - 1 ? `<a href="${c.path}">${esc(c.name)}</a>` : esc(c.name))).join(" / ")}
  </div>

  <h1>${esc(h1)}</h1>
  <div class="meta">Data from the IACS Vessels in Class dataset, as of ${asOfLong}. Refreshed weekly.</div>
${body}
</article>

<footer>
  <div>
    <p><a href="/class-societies/">Classification societies</a> &middot; <a href="/iacs-class-status-codes.html">IACS status codes</a> &middot; ${useCases.map((u) => `<a href="/use-cases/${u.slug}.html">${esc(u.h1)}</a>`).join(" &middot; ")}</p>
    <p>Built by <a href="https://wearefabbrik.com" target="_blank" rel="noopener">WeAreFabbrik</a> &middot; <a href="https://github.com/tsolman/vessel-class-finder" target="_blank">GitHub</a> &middot; <a href="/terms.html">Terms &amp; Privacy</a></p>
  </div>
</footer>

<script src="/seo-demo.js"></script>
</body>
</html>
`;
}

function demoBox(label) {
    return `
  <form class="demo" data-demo>
    <label for="demo-imo">${esc(label)}</label>
    <div class="demo-row">
      <input id="demo-imo" inputmode="numeric" pattern="[0-9]{7}" maxlength="7" placeholder="7-digit IMO, e.g. 9321483" aria-label="IMO number" required>
      <button class="btn" type="submit">Look up</button>
    </div>
    <div class="demo-result" hidden aria-live="polite"></div>
  </form>`;
}

function faqBlock(faq) {
    return `
  <h2>Frequently asked questions</h2>
  <div class="faq">
${faq.map((f) => `    <details>\n      <summary>${esc(f.q)}</summary>\n      <p>${esc(f.a)}</p>\n    </details>`).join("\n")}
  </div>`;
}

const faqLd = (faq) => ({
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
});

const cta = `
  <div class="cta-box">
    <h3>Check a whole fleet at once</h3>
    <p>Free API key: 100 lookups a month, up to 100 IMO numbers per request. Paid plans from $49/month.</p>
    <a href="/#signup" class="btn">Get a free API key</a>
  </div>`;

function statusTable(s) {
    const rows = [...STATUSES.map((st) => [st.key, s.statuses[st.key] || 0, st.inClass ? "In class" : "Not in class"]),
        ["No status recorded", s.statuses.None || 0, "Not stated"]].filter((r) => r[1] > 0);
    return `
  <div class="table-wrap"><table>
    <thead><tr><th>Status</th><th class="num">Vessels</th><th class="num">Share</th><th>Meaning</th></tr></thead>
    <tbody>
${rows.map(([k, n, m]) => `      <tr><td>${STATUSES.find((st) => st.key === k) ? `<a href="/iacs-class-status-codes.html#${k.toLowerCase()}">${k}</a>` : k}</td><td class="num">${fmt(n)}</td><td class="num">${pct(n, s.total)}</td><td>${m}</td></tr>`).join("\n")}
    </tbody>
  </table></div>`;
}

// ---------- society pages ----------
const bySize = [...societies].sort((a, b) => stats.societies[b.code].total - stats.societies[a.code].total);
const rank = (code) => bySize.findIndex((s) => s.code === code) + 1;

function societyPage(soc) {
    const s = stats.societies[soc.code];
    const ic = inClass(s);
    const sus = s.statuses.Suspended || 0;
    const wd = s.statuses.Withdrawn || 0;
    const codeNote = soc.code === soc.name || soc.code === soc.aka[0]
        ? `appears in the IACS data under the code <code>${soc.code}</code>`
        : `appears in the IACS data under the code <code>${soc.code}</code>, not "${esc(soc.aka[0])}"`;
    const topReasons = s.reasons.slice(0, 5);

    const faq = [
        { q: `How do I check if a ship is classed by ${soc.name}?`,
          a: `Enter the ship's 7-digit IMO number in the lookup on this page. If ${soc.name} classes it, the result shows class society ${soc.code}, the class status and the last and next survey dates. For many ships at once, use the API with up to 100 IMO numbers per request.` },
        { q: `What code does ${soc.name} use in IACS data?`,
          a: `${soc.code}. The IACS Vessels in Class dataset and this API identify ${soc.fullName} as "${soc.code}".` },
        { q: `How many ships does ${soc.name} class?`,
          a: `As of ${asOfLong}, the IACS dataset lists ${fmt(s.total)} ships under ${soc.name}, of which ${fmt(ic)} are in class (Delivered, Reinstated or Reassigned), ${fmt(sus)} suspended and ${fmt(wd)} withdrawn. That makes it number ${rank(soc.code)} of the 12 IACS members by ships listed.` },
        { q: `Is this official ${soc.name} data?`,
          a: `It is ${soc.name}'s own data as published by IACS in its Vessels in Class dataset, refreshed weekly. It is not a substitute for class certificates or the society's own records, which remain authoritative.` },
        { q: `Can I get ${soc.name} class status through an API?`,
          a: `Yes. POST a list of IMO numbers to /vessels with your API key and each result includes the class society code, status, survey dates and reason for the latest status change. The free tier includes 100 lookups a month.` },
    ];

    const body = `
  <div class="answer"><p><strong>${esc(soc.fullName)}</strong> ${codeNote}. As of ${asOfLong} the IACS dataset lists <strong>${fmt(s.total)} ships</strong> classed by ${esc(soc.name)}: ${fmt(ic)} in class, ${fmt(sus)} suspended and ${fmt(wd)} withdrawn. Look up any ${esc(soc.name)}-classed ship by IMO number below, or check up to 100 at once through the API.</p></div>
${demoBox(`Check a ship's ${soc.name} class status by IMO number (free, no signup)`)}

  <div class="stats">
    <div class="stat"><b>${fmt(s.total)}</b><span>ships listed</span></div>
    <div class="stat"><b>${fmt(ic)}</b><span>in class</span></div>
    <div class="stat"><b>${fmt(sus)}</b><span>suspended</span></div>
    <div class="stat"><b>${fmt(wd)}</b><span>withdrawn</span></div>
  </div>

  <h2>${esc(soc.name)} fleet by class status</h2>
  <p>How the ${fmt(s.total)} ships listed under <code>${soc.code}</code> break down by their latest IACS status:</p>
${statusTable(s)}
${topReasons.length ? `
  <h2>Most common reasons for status changes</h2>
  <p>The reason recorded with each ship's latest status change, where one is given:</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Reason</th><th class="num">Vessels</th></tr></thead>
    <tbody>
${topReasons.map((r) => `      <tr><td>${esc(r.reason)}</td><td class="num">${fmt(r.n)}</td></tr>`).join("\n")}
    </tbody>
  </table></div>` : ""}

  <h2>About ${esc(soc.name)}</h2>
  <ul>
    <li><strong>Full name:</strong> ${esc(soc.fullName)}</li>
    <li><strong>Also known as:</strong> ${soc.aka.map(esc).join(", ")}</li>
    <li><strong>Founded:</strong> ${soc.founded}</li>
    <li><strong>Headquarters:</strong> ${esc(soc.hq)}</li>
    <li><strong>IACS code:</strong> <code>${soc.code}</code></li>
    <li><strong>Website:</strong> <a href="${soc.website}" rel="noopener" target="_blank">${esc(soc.website.replace(/^https?:\/\//, ""))}</a></li>
  </ul>

  <h2>Check ${esc(soc.name)} class status through the API</h2>
  <p>Send IMO numbers to <code>/vessels</code>. Ships classed by ${esc(soc.name)} come back with <code>"class": "${soc.code}"</code>:</p>
<pre><code>curl -X POST ${API}/vessels \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"imos": [9321483, 9074729]}'</code></pre>
  <p>Filter the response on <code>class == "${soc.code}"</code> to find the ${esc(soc.name)}-classed ships in a list, and on <code>status</code> to find any that are <a href="/iacs-class-status-codes.html#suspended">suspended</a> or <a href="/iacs-class-status-codes.html#withdrawn">withdrawn</a>.</p>
${cta}
${faqBlock(faq)}

  <h2>Other IACS classification societies</h2>
  <ul class="related">
${bySize.filter((o) => o.code !== soc.code).map((o) => `    <li><a href="/class-societies/${o.slug}.html">${esc(o.name)}</a> <span class="note">(${fmt(stats.societies[o.code].total)} ships)</span></li>`).join("\n")}
  </ul>
  <p class="note">Numbers come from IACS's public Vessels in Class dataset and cover only ships classed by IACS members. They are not a substitute for class certificates or the society's own records.</p>`;

    return page({
        urlPath: `/class-societies/${soc.slug}.html`,
        title: `${soc.name} Class Status Lookup by IMO Number`,
        description: `Check any ${soc.name}-classed ship's class status and survey dates by IMO number. ${fmt(s.total)} ships listed under IACS code ${soc.code}, ${fmt(ic)} in class. Free lookup and API.`,
        h1: `${soc.name} class status lookup`,
        breadcrumb: [{ name: "Classification societies", path: "/class-societies/" }, { name: soc.name }],
        body,
        jsonld: [faqLd(faq)],
    });
}

// ---------- hub page ----------
function hubPage() {
    const t = stats.totals;
    const top = bySize[0];
    const faq = [
        { q: "How many classification societies are members of IACS?",
          a: "Twelve: ABS, Bureau Veritas, China Classification Society, Croatian Register of Shipping, DNV, Indian Register of Shipping, Korean Register, Lloyd's Register, ClassNK, Polish Register of Shipping, RINA and Türk Loydu." },
        { q: "Which classification society classes the most ships?",
          a: `In the IACS Vessels in Class dataset (as of ${asOfLong}), ${top.name} lists the most ships at ${fmt(stats.societies[top.code].total)}, followed by ${bySize[1].name} (${fmt(stats.societies[bySize[1].code].total)}) and ${bySize[2].name} (${fmt(stats.societies[bySize[2].code].total)}). Counts include ships whose class has since been suspended or withdrawn.` },
        { q: "How do I find out which classification society a ship is classed with?",
          a: "Look up the ship's IMO number. The result's class field gives the society code (for example NV for DNV, NKK for ClassNK, LRS for Lloyd's Register). Ships that don't appear are not classed by an IACS member." },
        { q: "Why is DNV shown as NV and ClassNK as NKK?",
          a: "Those are the codes IACS uses in its Vessels in Class dataset. The full list is NKK (ClassNK), BV, ABS, NV (DNV), LRS (Lloyd's Register), RINA, CCS, KR, IRS, PRS, CRS and TLV (Türk Loydu)." },
    ];
    const body = `
  <div class="answer"><p>IACS has 12 member classification societies. As of ${asOfLong} their Vessels in Class dataset lists <strong>${fmt(t.total)} ships</strong>: ${fmt(inClass(t))} in class, ${fmt(t.statuses.Suspended)} suspended and ${fmt(t.statuses.Withdrawn)} withdrawn. ${esc(top.name)} lists the most ships (${fmt(stats.societies[top.code].total)}). The table below gives each society's IACS code, fleet size and status breakdown.</p></div>
${demoBox("Find which society classes a ship: enter its IMO number (free, no signup)")}

  <h2>IACS classification societies compared</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Society</th><th>Code</th><th class="num">Ships</th><th class="num">In class</th><th class="num">Suspended</th><th class="num">Withdrawn</th></tr></thead>
    <tbody>
${bySize.map((soc) => { const s = stats.societies[soc.code]; return `      <tr><td><a href="/class-societies/${soc.slug}.html">${esc(soc.name)}</a></td><td><code>${soc.code}</code></td><td class="num">${fmt(s.total)}</td><td class="num">${fmt(inClass(s))}</td><td class="num">${fmt(s.statuses.Suspended)}</td><td class="num">${fmt(s.statuses.Withdrawn)}</td></tr>`; }).join("\n")}
      <tr><td><strong>All IACS members</strong></td><td></td><td class="num"><strong>${fmt(t.total)}</strong></td><td class="num"><strong>${fmt(inClass(t))}</strong></td><td class="num"><strong>${fmt(t.statuses.Suspended)}</strong></td><td class="num"><strong>${fmt(t.statuses.Withdrawn)}</strong></td></tr>
    </tbody>
  </table></div>
  <p class="note">"In class" counts the Delivered, Reinstated and Reassigned statuses. ${fmt(t.statuses.None)} ships have no status recorded. See <a href="/iacs-class-status-codes.html">what each IACS status means</a>.</p>

  <h2>What is IACS?</h2>
  <p>The International Association of Classification Societies (IACS) is the umbrella body of the major classification societies. Its members set and apply technical rules for ship design, construction and survey, and together they class most of the world's cargo-carrying tonnage. IACS publishes the class status of every ship its members class in the Vessels in Class dataset, as a downloadable file rather than an API.</p>
  <p>Vessel Class Finder loads that file every week and serves it as a JSON API, so you can check a ship's society, status and survey dates by IMO number instead of downloading and parsing the file yourself.</p>
${cta}
${faqBlock(faq)}`;
    return page({
        urlPath: "/class-societies/",
        title: "IACS Classification Societies: Codes and Fleet Sizes",
        description: `All 12 IACS classification societies compared: codes (NV, NKK, LRS...), ships classed, and how many are in class, suspended or withdrawn. ${fmt(t.total)} ships, updated weekly.`,
        h1: "IACS classification societies compared",
        breadcrumb: [{ name: "Classification societies" }],
        body,
        jsonld: [faqLd(faq)],
        wide: true,
    });
}

// ---------- status glossary ----------
function glossaryPage() {
    const t = stats.totals;
    const reasons = Object.entries(t.reasons).sort((a, b) => b[1] - a[1]);
    const faq = [
        { q: "What does 'Delivered' mean in IACS class status?",
          a: "It is the normal in-class status: the ship entered the society's class (typically on delivery as a newbuilding, or on transfer from another society) and has had no suspension or withdrawal since." },
        { q: "What is the difference between class suspended and class withdrawn?",
          a: "Suspended means class is temporarily invalid, usually because of an overdue survey or an unmet condition of class, and can be reinstated. Withdrawn means the society no longer classes the ship at all." },
        { q: "Is a ship with Reinstated or Reassigned status in class?",
          a: "Yes. Reinstated means class was restored after a suspension; Reassigned means class was assigned again after a withdrawal or transfer. Both are in-class statuses, though the history is worth reviewing in due diligence." },
        { q: "What does 'Transfer of class to a non-IACS society' mean?",
          a: `The ship left an IACS member for a society outside IACS. It is recorded for ${fmt(t.reasons["Transfer of class to a non-IACS society"] || 0)} ships in the current dataset and is often treated as a risk indicator in vetting and sanctions screening.` },
        { q: "How can I check a ship's IACS class status?",
          a: "Enter its IMO number in the lookup on this page, or query up to 100 IMO numbers at once through the Vessel Class Finder API. Data comes from the IACS Vessels in Class dataset and is refreshed weekly." },
    ];
    const body = `
  <div class="answer"><p>The IACS Vessels in Class dataset uses five class statuses. <strong>Delivered</strong>, <strong>Reinstated</strong> and <strong>Reassigned</strong> mean the ship is in class; <strong>Suspended</strong> means class is temporarily invalid; <strong>Withdrawn</strong> means the society no longer classes the ship. Each status change can carry a reason, such as "Survey overdue" or "Transfer of class to a non-IACS society".</p></div>

  <h2>IACS class statuses</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Status</th><th>In class?</th><th class="num">Ships</th><th>Meaning</th></tr></thead>
    <tbody>
${STATUSES.map((st) => `      <tr><td><a href="#${st.slug}">${st.key}</a></td><td>${st.inClass ? "Yes" : "No"}</td><td class="num">${fmt(t.statuses[st.key])}</td><td>${esc(st.short)}</td></tr>`).join("\n")}
    </tbody>
  </table></div>
${STATUSES.map((st) => `
  <h2 id="${st.slug}">${st.key}</h2>
  <p>${esc(st.long)} ${fmt(t.statuses[st.key])} ships (${pct(t.statuses[st.key], t.total)} of the dataset) currently have this status.</p>`).join("")}

  <h2 id="reasons">Reasons for status changes</h2>
  <p>IACS records a reason with many status changes. These are all the reasons in the current dataset:</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Reason</th><th class="num">Ships</th></tr></thead>
    <tbody>
${reasons.map(([r, n]) => `      <tr><td>${esc(r)}</td><td class="num">${fmt(n)}</td></tr>`).join("\n")}
    </tbody>
  </table></div>
  <p class="note">A reason describes the ship's latest status change, so it can appear alongside an in-class status (for example "Survey overdue" on a ship that was suspended and later reinstated).</p>
${demoBox("Check a ship's current status by IMO number (free, no signup)")}

  <h2>Status in the API</h2>
  <p>Every record from <code>/vessels</code> includes <code>status</code>, <code>reason_for_status</code> and <code>date_of_latest_status</code>, so you can filter a fleet for suspended or withdrawn ships in one request:</p>
<pre><code>{
  "imo": 1000617,
  "class": "LRS",
  "status": "Withdrawn",
  "reason_for_status": "Survey overdue",
  "date_of_latest_status": "25/01/2025",
  "date_of_next_survey": "30/12/2026"
}</code></pre>
${cta}
${faqBlock(faq)}
  <p class="note">Status meanings summarise how the statuses are used in the IACS dataset. Class certificates and the classification society's own records remain authoritative.</p>`;
    return page({
        urlPath: "/iacs-class-status-codes.html",
        title: "IACS Class Status Codes Explained: Delivered, Suspended...",
        description: "What IACS class statuses mean: Delivered, Reinstated, Reassigned, Suspended and Withdrawn, plus every reason code, with counts from the live Vessels in Class dataset.",
        h1: "IACS class status codes explained",
        breadcrumb: [{ name: "IACS status codes" }],
        body,
        jsonld: [faqLd(faq), {
            "@context": "https://schema.org", "@type": "DefinedTermSet", name: "IACS class statuses",
            hasDefinedTerm: STATUSES.map((st) => ({ "@type": "DefinedTerm", name: st.key, description: st.long, url: `${SITE}/iacs-class-status-codes.html#${st.slug}` })),
        }],
        wide: true,
    });
}

// ---------- use-case pages ----------
function useCasePage(u) {
    const body = `
  <div class="answer"><p>${esc(u.answer)}</p></div>
${demoBox("Try it: check a ship's class status by IMO number (free, no signup)")}
${u.sections.map((s) => `\n  <h2>${esc(s.h2)}</h2>\n  ${s.html}`).join("\n")}
${cta}
${faqBlock(u.faq)}

  <h2>Related</h2>
  <ul>
    <li><a href="/iacs-class-status-codes.html">IACS class status codes explained</a></li>
    <li><a href="/class-societies/">IACS classification societies compared</a></li>
${useCases.filter((o) => o.slug !== u.slug).map((o) => `    <li><a href="/use-cases/${o.slug}.html">${esc(o.h1)}</a></li>`).join("\n")}
  </ul>`;
    return page({
        urlPath: `/use-cases/${u.slug}.html`,
        title: u.title,
        description: u.meta_description,
        h1: u.h1,
        breadcrumb: [{ name: u.h1 }],
        body,
        jsonld: [faqLd(u.faq)],
    });
}

// ---------- MCP connector docs ----------
function mcpPage() {
    const MCP_URL = `${API}/mcp`;
    const faq = [
        { q: "Can Claude check a ship's class status?",
          a: `Yes. Add Vessel Class Finder as a connector (URL ${MCP_URL}) and ask Claude, for example, "Is IMO 9321483 in class?". Claude calls the lookup_vessel tool and answers from the IACS Vessels in Class data.` },
        { q: "Do I need an API key?",
          a: "No for single-ship lookups, which share a free daily allowance. Yes for batch lookups of up to 100 ships and for usage checks: connect with your API key, and lookups count against your plan exactly as API calls do." },
        { q: "Which AI tools does it work with?",
          a: "Any client that supports remote MCP servers over Streamable HTTP, including Claude (web, desktop and mobile), Claude Code and Cursor. A local stdio version is also available as an npm package." },
        { q: "What data does the connector send to Vessel Class Finder?",
          a: "Only the tool calls: the IMO numbers looked up and, if you connect with one, your API key. It never receives your conversation. See the privacy policy for details." },
    ];
    const body = `
  <div class="answer"><p>Vessel Class Finder has a remote MCP server at <code>${MCP_URL}</code>, so Claude and other AI assistants can look up any IACS-classed ship's class society, class status and survey dates by IMO number. Single-ship lookups work without an account; connect with an API key for batch lookups of up to 100 ships.</p></div>

  <h2>Tools</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Tool</th><th>API key</th><th>What it does</th></tr></thead>
    <tbody>
      <tr><td><code>lookup_vessel</code></td><td>Optional</td><td>One ship by IMO: society, status, in class or not, last and next survey, reason for the latest status change</td></tr>
      <tr><td><code>lookup_vessels</code></td><td>Required</td><td>1–100 ships in one call, plus the IMOs not found in IACS data</td></tr>
      <tr><td><code>check_usage</code></td><td>Required</td><td>Your plan and lookups used and remaining this month</td></tr>
    </tbody>
  </table></div>
  <p>All tools are read-only. Without a key, <code>lookup_vessel</code> uses a shared free daily allowance; with a key, every lookup counts against your plan (Free: 100 a month).</p>

  <h2>Add it to Claude</h2>
  <ol>
    <li>In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong> (or find Vessel Class Finder in the connector directory once it's listed).</li>
    <li>Enter the URL <code>${MCP_URL}</code>.</li>
    <li>Ask, for example: <em>"Is IMO 9321483 in class, and when is its next survey?"</em></li>
  </ol>

  <h2>Claude Code</h2>
<pre><code># Single-ship lookups, no key
claude mcp add --transport http vessel-class-finder ${MCP_URL}

# With your API key for batch lookups
claude mcp add --transport http vessel-class-finder ${MCP_URL} \\
  --header "Authorization: Bearer YOUR_API_KEY"</code></pre>

  <h2>Cursor and other MCP clients</h2>
<pre><code>{
  "mcpServers": {
    "vessel-class-finder": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}</code></pre>
  <p>Leave out <code>headers</code> to use single-ship lookups without a key. Get a free key at <a href="/#signup">vesselclassfinder.com</a>.</p>

  <h2>Example questions</h2>
  <ul>
    <li>Which classification society classes IMO 9321483, and is it in class?</li>
    <li>Check these 20 IMO numbers and list any with suspended or withdrawn class.</li>
    <li>Which of these ships has a class survey due in the next three months?</li>
    <li>How many lookups do I have left this month?</li>
  </ul>

  <h2>Limits</h2>
  <p>Data is the IACS Vessels in Class dataset, refreshed weekly. It covers ships classed by the 12 IACS members and is not a substitute for class certificates or the society's own records. See <a href="/iacs-class-status-codes.html">what each status means</a>.</p>
${faqBlock(faq)}
  <p class="note">Support: <a href="mailto:info@wearefabbrik.com">info@wearefabbrik.com</a> &middot; <a href="/terms.html#privacy">Privacy policy</a></p>`;
    return page({
        urlPath: "/mcp.html",
        title: "Vessel Class Finder MCP Server for Claude and AI Assistants",
        description: "Let Claude and other AI assistants check a ship's IACS class status by IMO number. Remote MCP server: free single-ship lookups, batch lookups with an API key.",
        h1: "Use Vessel Class Finder in Claude and other AI assistants",
        breadcrumb: [{ name: "MCP server" }],
        body,
        jsonld: [faqLd(faq)],
    });
}

// ---------- write ----------
const written = [];
function write(urlPath, html) {
    const file = path.join(DOCS, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    written.push(urlPath);
}

write("/class-societies/", hubPage());
for (const soc of societies) write(`/class-societies/${soc.slug}.html`, societyPage(soc));
write("/iacs-class-status-codes.html", glossaryPage());
write("/mcp.html", mcpPage());
for (const u of useCases) write(`/use-cases/${u.slug}.html`, useCasePage(u));

// Sitemap: hand-written pages plus everything generated above.
const staticPages = [
    { loc: "/", priority: "1.0" },
    { loc: "/blog/vessel-classification-api.html", priority: "0.8" },
    { loc: "/terms.html", priority: "0.3" },
];
const entries = [
    ...staticPages.map((p) => ({ ...p, lastmod: stats.asOf })),
    ...written.map((loc) => ({ loc, lastmod: stats.asOf, priority: loc === "/class-societies/" || loc.startsWith("/iacs") ? "0.8" : "0.7" })),
];
fs.writeFileSync(path.join(DOCS, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((e) => `  <url>\n    <loc>${SITE}${e.loc}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n    <priority>${e.priority}</priority>\n  </url>`).join("\n")}
</urlset>
`);

console.log(`Generated ${written.length} pages and sitemap.xml (${entries.length} URLs)`);
