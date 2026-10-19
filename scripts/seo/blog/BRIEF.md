# Blog article brief (for writers)

Each article is one JSON file in `scripts/seo/blog/<slug>.json`. `scripts/seo/build.mjs` renders it to `docs/blog/<slug>.html`. Do not write HTML pages yourself and do not edit build.mjs.

## JSON shape

```json
{
  "slug": "how-to-check-vessel-class-status",
  "date": "2026-10-19",
  "title": "<= 60 chars, keyword first, for the <title> tag",
  "meta_description": "140-160 chars, plain, says what the reader gets",
  "h1": "The question or topic as a reader would phrase it",
  "primary_keyword": "main search phrase",
  "summary": "One sentence for the blog index card (max ~160 chars).",
  "answer": "40-70 word direct answer to the h1, written so an AI assistant or Google could quote it on its own. No links, no markdown.",
  "sections": [ { "h2": "...", "html": "<p>...</p>" } ],
  "faq": [ { "q": "...", "a": "plain text, 1-3 sentences" } ],
  "related": ["other-blog-slug", "/iacs-class-status-codes.html"]
}
```

- 5 to 8 sections, 1,000 to 1,600 words in total across answer + sections. 4 to 6 FAQ items (questions people actually type into Google or ChatGPT).
- `html` may use only: p, ul, ol, li, strong, em, code, a, table/thead/tbody/tr/th/td, blockquote. No h1/h2 inside html (use h3 sparingly if needed). Valid JSON: escape double quotes inside html as \" or use single quotes for attributes.
- `related`: 2 to 4 entries; blog slugs (no extension) or site paths starting with "/".

## Facts

Use ONLY facts from `marketing/FACTS.md` and `scripts/seo/stats.json` for product claims and numbers. Snapshot date: 30 September 2026. Cite numbers exactly as given there (e.g. 60,223 ships; 4,848 Withdrawn; 1,589 "Survey overdue").

General maritime knowledge (what IACS is, survey cycles, TOCA, P&I, IMO numbers) is fine, but:
- Hedge anything you are not certain of ("typically", "usually", "under most class rules"). Never invent regulations, statistics, rule numbers, quotes, customers or case studies.
- You may use WebSearch/WebFetch to verify a general fact. Prefer primary sources (iacs.org.uk, imo.org). Do not copy text from them.
- Do not claim the product does things it doesn't: no sanctions-list matching, no ownership data, no class certificates, only the 12 IACS societies, weekly refresh.

Example IMOs you may cite (verified real records):
- 9811000 EVER GIVEN: ABS, Delivered, last survey 12/07/2023, next survey 24/09/2028.
- 9321483 EMMA MAERSK, 9703291 MSC OSCAR (check fields before quoting them).
To quote any other ship's data, verify first: `curl -s https://vessel-class-finder-production.up.railway.app/demo/<IMO>`. A 404 means not in the data; do not use it.

Shareable lookup link: `https://vesselclassfinder.com/?imo=9811000` opens the free lookup with that ship's result. Use it once per article where it fits naturally.

## Internal links (use 3+ per article, relative paths)

- `/` free lookup + API + pricing; `/#signup` free API key
- `/class-societies/` and `/class-societies/{classnk,bureau-veritas,abs,dnv,lloyds-register,rina,china-classification-society,korean-register,indian-register,polish-register,croatian-register,turk-loydu}.html`
- `/iacs-class-status-codes.html` statuses explained
- `/use-cases/sanctions-kyc-screening.html`, `/use-cases/charter-vetting.html`, `/use-cases/marine-insurance.html`
- `/blog/vessel-classification-api.html` API guide; `/mcp.html` Claude connector
- Other new blog posts: `/blog/<slug>.html` (slugs listed in the assignment)

## Voice

Plain, specific, short sentences, answer first. No hype words (unlock, seamless, leverage, revolutionize, game-changer, cutting-edge, robust, delve). No emojis. Numbers over adjectives. British/international spelling is fine, be consistent. Mention Vessel Class Finder where it genuinely helps the reader, not in every section; the article must be useful even to someone who never uses the product. End sections with substance, not a sales pitch (the page template adds the CTA).

## All 10 slugs (for cross-links)

1. how-to-check-vessel-class-status
2. what-is-an-imo-number
3. what-is-a-classification-society
4. what-is-iacs
5. non-iacs-classification-societies
6. class-suspended-vs-withdrawn
7. transfer-of-class
8. ship-survey-cycle-explained
9. shadow-fleet-class-red-flags
10. class-and-marine-insurance

## Validate before finishing

`node -e 'JSON.parse(require("fs").readFileSync("scripts/seo/blog/<slug>.json","utf8"))'` for each of your files, and count words roughly. Report back: slugs written, word counts, any facts you were unsure about.
