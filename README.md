# PatentScanner

Automated weekly patent monitoring for the coffee and beverage industry. Scrapes Google Patents search results, extracts abstracts and metadata, and delivers a delta report by email every Monday.

---

## How it works

1. **Every Monday at 08:00 UTC** GitHub Actions spins up a runner
2. The scraper runs through all configured queries sequentially using Playwright (headless Chrome)
3. For each result, the abstract is fetched from the patent detail page
4. Only patents not already in the archive are saved (deduplication by patent ID)
5. A delta report (new patents only) is saved to `delta/` and emailed as an attachment
6. Results are committed back to the repo as JSON, CSV, and Markdown

You can also trigger a run manually from **Actions → Weekly Patent Scan → Run workflow**.

---

## Repository structure

```
config.json                  ← Edit this to change queries, date range, page limits
scripts/scrape.js            ← Scraper (do not edit unless fixing a bug)
results/
  patents.json               ← Full accumulated archive (all runs)
  patents.csv                ← Same data, spreadsheet-ready
  patents.md                 ← Same data, human-readable in GitHub
delta/
  delta_YYYY-MM-DD_to_YYYY-MM-DD.txt  ← New patents per run (also emailed)
.github/workflows/
  weekly-scan.yml            ← Schedule and CI configuration
```

---

## Configuring queries — `config.json`

This is the **only file** collaborators need to edit. The scraper reads it fresh on every run.

### Query structure

Each entry in the `queries` array is an object with three fields:

```json
{
  "_label": "Human-readable name shown in logs and reports",
  "query":  "Google Patents search string",
  "maxPages": 2
}
```

`maxPages` is optional — if omitted, the global `maxPages` value is used.

### Adding a query

Add a new object to the `queries` array:

```json
{
  "_label": "Watchtower - espresso and IoT",
  "query": "A47J31 AND H04W",
  "maxPages": 1
}
```

### Removing a query

Delete its object from the array. Make sure the preceding entry still ends with a comma.

### Changing a query

Edit the `"query"` string in place. The `_label` is just for humans — it does not affect what gets searched.

---

## Query tiers

The current query set follows a three-tier strategy:

| Tier | Purpose | `maxPages` |
|------|---------|-----------|
| **Core** | Broad CPC class — maximum coverage, some noise | 3 |
| **Segment** | CPC + abstract keyword filter — domain-specific | 2 |
| **Watchtower** | Two CPC classes — cross-domain signals (AI, sensors, control) | 1 |

### Current queries

#### Core — broad domain coverage

| Label | Query | Pages |
|-------|-------|-------|
| Coffee food domain | `A23F` | 3 |
| Coffee preparation and extraction | `A23F5` | 3 |
| Beverage preparation machines | `A47J31` | 3 |
| Coffee grinders | `A47J42` | 3 |
| Coffee and beverage packaging | `B65D AND AB=(coffee OR milk OR beverage)` | 2 |

#### Segment — topic-specific

| Label | Query | Pages |
|-------|-------|-------|
| Extraction and brewing | `A23F5 AND AB=(coffee OR espresso OR beverage OR brewing OR extraction)` | 2 |
| Roasting | `A23F5/04 AND AB=(coffee OR roast OR roasting)` | 2 |
| Grinders and grind adjustment | `A47J42 AND AB=(coffee OR grinder OR grind OR grinding OR particle)` | 2 |
| Beverage machines and systems | `A47J31 AND AB=(coffee OR espresso OR beverage OR system OR apparatus)` | 2 |
| Milk systems | `A47J31/44 AND AB=(milk AND (foam OR froth OR dispensing OR cleaning))` | 2 |
| Cleaning and hygiene | `AB=((coffee OR espresso OR milk OR beverage) AND (cleaning OR hygiene OR maintenance))` | 2 |
| Capsules and pods | `AB=((coffee OR espresso) AND (capsule OR pod))` | 2 |
| Cold brew and concentrate | `AB=((coffee OR espresso) AND ("cold brew" OR concentrate OR extract))` | 2 |

#### Watchtower — cross-domain technology signals

| Label | Query | Pages |
|-------|-------|-------|
| Extraction + analysis (G01N) | `A23F5/08 AND G01N` | 1 |
| Extraction + process control (G05B) | `A23F5/08 AND G05B` | 1 |
| Extraction + AI/ML (G06N) | `A23F5/08 AND G06N` | 1 |
| Machine + sensing (G01N) | `A47J31 AND G01N` | 1 |
| Grinder + control (G05B) | `A47J42 AND G05B` | 1 |

### CPC codes used

| Code | Description |
|------|-------------|
| `A23F` | Coffee, tea, their substitutes |
| `A23F5` | Coffee — preparation, preservation |
| `A23F5/04` | Roasting |
| `A23F5/08` | Extraction |
| `A47J31` | Beverage preparation machines |
| `A47J31/44` | Milk heating/frothing devices |
| `A47J42` | Coffee grinders |
| `A47L` | Cleaning equipment |
| `B65D` | Packaging and containers |
| `G01N` | Measurement and analysis |
| `G05B` | Process control systems |
| `G06N` | Machine learning / AI |
| `H04L` | Data transmission networks |
| `H04W` | Wireless networks |

---

## Global settings

| Field | Default | Description |
|-------|---------|-------------|
| `recentDays` | `7` | Looks back N days from today on every run. Set to `0` to use `afterDate` instead |
| `maxPages` | `2` | Default pages per query if not overridden per-query (10 results per page) |
| `afterDate` | `""` | Fixed start date `YYYY-MM-DD`. Only used if `recentDays` is `0` |
| `beforeDate` | `""` | Fixed end date. Usually left blank |
| `type` | `"PATENT"` | `"PATENT"` = applications + grants. `"PATENT_GRANT"` = granted only |
| `status` | `""` | `""` = all, `"GRANT"` = granted, `"PENDING"` = pending |
| `fetchDelayMs` | `1500` | Milliseconds between fetching individual patent pages |
| `pageDelayMs` | `3000` | Milliseconds between result pages |

---

## Output files

### `results/patents.json`

Full structured archive. Every patent ever found, accumulated across all runs. Fields:

```json
{
  "id":           "CN121587556A",
  "country":      "China",
  "kind":         "Application",
  "title":        "Steam coffee machine",
  "assignee":     "Ningbo Corp Ltd",
  "inventor":     "Zhang Wei",
  "priorityDate": "2026-01-21",
  "filingDate":   "2026-01-21",
  "pubDate":      "2026-03-03",
  "grantDate":    "",
  "url":          "https://patents.google.com/patent/CN121587556A/en",
  "abstract":     "The invention provides a steam coffee machine...",
  "query":        "A47J31",
  "scraped_at":   "2026-04-11T08:03:22.000Z"
}
```

### `results/patents.csv`

Same data as spreadsheet rows. Open in Excel or import into any data tool.

### `results/patents.md`

Human-readable version. Best viewed directly on GitHub — click the file and GitHub renders it as a formatted page.

### `delta/delta_YYYY-MM-DD_to_YYYY-MM-DD.txt`

New patents found in the current run only, grouped by query. One file per run, also sent by email. Filename encodes the scan period.

---

## Secrets required

Set these in **Settings → Secrets and variables → Actions** on the repo:

| Secret | Description |
|--------|-------------|
| `GMAIL_ADDRESS` | Gmail address to send from |
| `GMAIL_APP_PASSWORD` | 16-character Gmail App Password (not your regular password) |
| `EMAIL_RECIPIENT` | Address to receive the weekly report (can be same as `GMAIL_ADDRESS`) |

To generate a Gmail App Password: Google Account → Security → 2-Step Verification → App passwords.

---

## Manual trigger

Go to **Actions → Weekly Patent Scan → Run workflow**. Optional overrides:

| Input | Description |
|-------|-------------|
| Query | Run a single query instead of all (leave blank to use `config.json`) |
| Max pages | Override pages per query |
| Recent days | Override the lookback window |

---

## Running locally

```bash
npm install
npx playwright install chromium
node scripts/scrape.js
```

Override config via environment variables:

```bash
PATENTS_QUERY="A23F5/08 AND G06N" PATENTS_MAX_PAGES=1 PATENTS_RECENT_DAYS=30 node scripts/scrape.js
```
