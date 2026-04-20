/**
 * Google Patents scraper — full metadata + abstract
 *
 * Strategy:
 *  1. Playwright loads each search results page (JS-rendered, full data visible)
 *  2. Extract ALL metadata from cards via Playwright (title, assignee, dates, ID)
 *     — these fields are in the Polymer shadow DOM, only visible after JS renders
 *  3. Plain HTTPS fetch each patent detail page just for the abstract
 *     (abstract lives in <meta name="description"> which is in the server HTML)
 *
 * Results accumulate across weekly runs (dedup by patent ID).
 */

const { chromium } = require("playwright");
const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH   = path.join(__dirname, "..", "config.json");
const RESULTS_DIR   = path.join(__dirname, "..", "results");
const EXISTING_PATH = path.join(RESULTS_DIR, "patents.json");

// Returns a YYYY-MM-DD date string N days before today
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch {}
  }

  const recentDays  = parseInt(process.env.PATENTS_RECENT_DAYS || file.recentDays || "7", 10);
  const afterDate   = recentDays > 0 ? daysAgo(recentDays) : (process.env.PATENTS_AFTER || file.afterDate || "");
  const beforeDate  = process.env.PATENTS_BEFORE || file.beforeDate || "";
  const type        = process.env.PATENTS_TYPE   || file.type       || "PATENT";
  const status      = process.env.PATENTS_STATUS || file.status     || "";
  const maxPages    = parseInt(process.env.PATENTS_MAX_PAGES    || file.maxPages    || "3",    10);
  const fetchDelayMs = parseInt(process.env.PATENTS_FETCH_DELAY || file.fetchDelayMs || "1500", 10);
  const pageDelayMs  = parseInt(process.env.PATENTS_PAGE_DELAY  || file.pageDelayMs  || "3000", 10);

  // ── Queries ────────────────────────────────────────────────────────────────
  // If PATENTS_QUERY env var is set (manual trigger override), use it as the
  // sole query. Otherwise use the queries array from config.json.
  // Each query entry can be a plain string or an object:
  //   { "query": "espresso machine", "maxPages": 2 }  ← per-query page override
  let queries;
  if (process.env.PATENTS_QUERY && process.env.PATENTS_QUERY.trim()) {
    queries = [{ query: process.env.PATENTS_QUERY.trim(), maxPages }];
  } else if (Array.isArray(file.queries) && file.queries.length > 0) {
    queries = file.queries.map(q => {
      if (typeof q === "string") return { query: q, maxPages };
      return { query: q.query, label: q._label || q.label || "", maxPages: q.maxPages || maxPages };
    });
  } else {
    // Fallback to single query field for backwards compatibility
    queries = [{ query: file.query || "coffee machine", maxPages }];
  }

  return { queries, recentDays, afterDate, beforeDate, type, status, fetchDelayMs, pageDelayMs };
}

// ---------------------------------------------------------------------------
// Search URL
// ---------------------------------------------------------------------------
function buildSearchUrl(config, page = 0) {
  const params = new URLSearchParams();
  params.set("q", "(" + config.query + ")");
  if (config.afterDate)  params.set("after",  "priority:" + config.afterDate.replace(/-/g, ""));
  if (config.beforeDate) params.set("before", "priority:" + config.beforeDate.replace(/-/g, ""));
  if (config.type)       params.set("type",   config.type);
  if (config.status)     params.set("status", config.status);
  if (page > 0)          params.set("page",   String(page));
  return "https://patents.google.com/?" + params.toString();
}

// ---------------------------------------------------------------------------
// Extract ALL card data via Playwright using textContent parsing.
//
// Google Patents uses CLOSED Polymer shadow roots — querySelector into them
// returns nothing. However, textContent DOES leak through as a flat string.
// Card text format (from observation):
//   Line 1: Patent ID (CN121512341A)
//   Line 2: Title (Coffee extraction method and apparatus)
//   Line 3: Dates (Priority 2026-01-06 • Filed 2026-01-06 • Published 2026-02-13)
//   Line 4: Assignee/Inventor (黄庆初 宁波浩嘉电器有限公司)
// ---------------------------------------------------------------------------
async function extractCardsFromPage(page) {
  // First dump raw card data for debugging if needed
  const raw = await page.evaluate(() => {
    const cards = document.querySelectorAll("search-result-item");
    return Array.from(cards).map(el => ({
      resultAttr: el.getAttribute("result") || el.getAttribute("data-result") || "",
      // Get all attributes to find where the ID might be hiding
      attrs: Array.from(el.attributes).map(a => ({ n: a.name, v: a.value.slice(0, 80) })),
      text: (el.textContent || "").slice(0, 500),
    }));
  });

  const results = [];
  for (const card of raw) {
    try {
      // ── Extract ID ───────────────────────────────────────────────────────
      let id = "";

      // Strategy 1: result/data-result attribute
      if (card.resultAttr) {
        id = card.resultAttr
          .replace(/^patent\//, "")
          .replace(/\/en.*$/, "")
          .trim();
      }

      // Strategy 2: scan ALL attributes for a patent number pattern
      if (!id) {
        for (const { v } of card.attrs) {
          const m = v.match(/^(?:patent\/)?([A-Z]{2}\d{5,}[A-Z]?\d?)(?:\/|$)/);
          if (m) { id = m[1]; break; }
        }
      }

      // Strategy 3: extract from textContent using patent number regex
      if (!id) {
        const m = card.text.match(/\b([A-Z]{2}\d{6,12}[A-Z]?\d?)\b/);
        if (m) id = m[1];
      }

      if (!id) continue;

      // ── Parse textContent lines ───────────────────────────────────────────
      const lines = card.text.split("\n").map(l => l.trim()).filter(l => l.length > 1);

      let title = "", inventor = "", assignee = "";
      let priorityDate = "", filingDate = "", pubDate = "", grantDate = "";

      // Date line
      const dateLine = lines.find(l => /Priority|Filed|Published|Granted/.test(l)) || "";
      const pm = dateLine.match(/Priority\s+([\d-]+)/i);
      const fm = dateLine.match(/Filed\s+([\d-]+)/i);
      const bm = dateLine.match(/Published\s+([\d-]+)/i);
      const gm = dateLine.match(/Granted\s+([\d-]+)/i);
      if (pm) priorityDate = pm[1];
      if (fm) filingDate   = fm[1];
      if (bm) pubDate      = bm[1];
      if (gm) grantDate    = gm[1];

      // Filter noise — use simple string checks instead of complex regex
      // to avoid any backtracking issues in the browser sandbox
      const isDateLine     = l => /Priority|Filed|Published|Granted/.test(l);
      const isSnippet      = l => l.length > 150 || /^\d+\.\s/.test(l);
      const isPatentNum    = l => /^[A-Z]{2}\d{5,}/.test(l) && l.length < 20;
      // Country codes: short line of space-separated 2-letter codes
      // Use simple check instead of catastrophic-backtracking regex
      const isCountryCodes = l => {
        if (l.length > 40) return false;
        return l.split(/\s+/).every(w => /^[A-Z]{2}$/.test(w));
      };

      const content = lines.filter(l =>
        l.length > 1 &&
        l !== id &&
        !isDateLine(l) &&
        !isSnippet(l) &&
        !isPatentNum(l) &&
        !isCountryCodes(l)
      );

      const looksLikeTitle = l =>
        l.length > 15 &&
        /\s/.test(l) &&
        !/，|、|·/.test(l) &&
        /[a-zA-Z]/.test(l);

      if (content.length === 1) {
        if (looksLikeTitle(content[0])) title = content[0];
        else assignee = content[0];
      } else if (content.length === 2) {
        if (looksLikeTitle(content[0])) { title = content[0]; inventor = content[1]; }
        else { inventor = content[0]; assignee = content[1]; }
      } else if (content.length >= 3) {
        title = content[0]; inventor = content[1]; assignee = content[2];
      }

      const url = "https://patents.google.com/patent/" + id + "/en";
      results.push({ id, title, inventor, assignee, priorityDate, filingDate, pubDate, grantDate, url });
    } catch (e) {
      // Skip malformed cards silently
    }
  }
  return results;
}

async function pageHasResults(page) {
  return page.evaluate(() => document.querySelectorAll("search-result-item").length > 0);
}

// ---------------------------------------------------------------------------
// Fetch abstract from patent detail page via plain HTTPS
// Google's server HTML includes <meta name="description"> with the abstract.
// Title/assignee are NOT in the server HTML (Polymer renders them) — that's
// why we get those from the search results page instead (see above).
// ---------------------------------------------------------------------------
function fetchUrl(url, hops = 0) {
  if (hops > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 20000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, hops + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function decodeEntities(str) {
  return (str || "")
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function extractAbstract(html) {
  // 1. <meta name="description"> — most reliable, Google puts abstract here
  let m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{40,4000})["']/i);
  if (!m) m = html.match(/<meta[^>]+content=["']([^"']{40,4000})["'][^>]+name=["']description["']/i);
  if (m) return decodeEntities(m[1].trim());

  // 2. og:description
  m = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{40,4000})["']/i);
  if (!m) m = html.match(/<meta[^>]+content=["']([^"']{40,4000})["'][^>]+property=["']og:description["']/i);
  if (m) return decodeEntities(m[1].trim());

  // 3. First substantial paragraph
  for (const pm of html.matchAll(/<p[^>]*>([\s\S]{80,2000}?)<\/p>/gi)) {
    const t = pm[1].replace(/<[^>]+>/g, "").trim();
    if (t.length > 80 && t.length < 2000) return decodeEntities(t);
  }

  return null;
}

async function fetchAbstract(url) {
  try {
    const html = await fetchUrl(url);
    return extractAbstract(html);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Country and kind helpers
// ---------------------------------------------------------------------------
const COUNTRY_MAP = {
  CN: "China", US: "United States", EP: "European Patent Office",
  WO: "PCT (International)", DE: "Germany", JP: "Japan",
  KR: "South Korea", GB: "United Kingdom", FR: "France",
  AU: "Australia", CA: "Canada", TW: "Taiwan", IN: "India",
  BR: "Brazil", RU: "Russia", IT: "Italy", ES: "Spain",
  NL: "Netherlands", SE: "Sweden", CH: "Switzerland",
};

const KIND_MAP = {
  A: "Application", A1: "Application", A2: "Application", A9: "Application",
  B: "Grant", B1: "Grant", B2: "Grant", B9: "Grant",
  U: "Utility Model", C: "Certificate of Addition",
  S: "Design Patent",
};

function getCountry(id) {
  const m = id.match(/^([A-Z]{2})/);
  return m ? (COUNTRY_MAP[m[1]] || m[1]) : "";
}

function getKind(id) {
  const m = id.match(/([A-Z]\d?)$/);
  if (!m) return "";
  return KIND_MAP[m[1]] || ("Type " + m[1]);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadExisting() {
  if (!fs.existsSync(EXISTING_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(EXISTING_PATH, "utf8"));
    const map  = {};
    (data.patents || []).forEach(p => { if (p.id) map[p.id] = p; });
    console.log("Loaded " + Object.keys(map).length + " existing patents.");
    return map;
  } catch {
    console.log("No existing results — starting fresh.");
    return {};
  }
}

function saveResults(patents) {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // JSON
  fs.writeFileSync(EXISTING_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    total:     patents.length,
    patents,
  }, null, 2));

  // CSV
  const esc = v => '"' + String(v || "").replace(/"/g, '""') + '"';
  const HDR = ["id","country","kind","title","assignee","inventor","priorityDate","filingDate","pubDate","grantDate","url","abstract","scraped_at"];
  const rows = patents.map(p =>
    [p.id, p.country, p.kind, p.title, p.assignee, p.inventor,
     p.priorityDate, p.filingDate, p.pubDate, p.grantDate,
     p.url, p.abstract, p.scraped_at].map(esc).join(",")
  );
  fs.writeFileSync(
    path.join(RESULTS_DIR, "patents.csv"),
    [HDR.join(","), ...rows].join("\n")
  );

  // Markdown
  const lines = [
    "# Patent Abstracts",
    "",
    `_Last updated: ${new Date().toUTCString()}_  `,
    `_Total patents: **${patents.length}**_`,
    "",
    "---",
    "",
  ];
  for (let i = 0; i < patents.length; i++) {
    const p = patents[i];
    lines.push(`## ${i + 1}. ${p.title || p.id}`);
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|-------|-------|");
    lines.push(`| **Patent ID** | \`${p.id}\` |`);
    lines.push(`| **Country / Office** | ${p.country || "—"} |`);
    lines.push(`| **Type** | ${p.kind || "—"} |`);
    lines.push(`| **Assignee** | ${p.assignee || "—"} |`);
    lines.push(`| **Inventor** | ${p.inventor || "—"} |`);
    lines.push(`| **Priority date** | ${p.priorityDate || "—"} |`);
    lines.push(`| **Filing date** | ${p.filingDate || "—"} |`);
    lines.push(`| **Publication date** | ${p.pubDate || "—"} |`);
    if (p.grantDate) lines.push(`| **Grant date** | ${p.grantDate} |`);
    lines.push(`| **Link** | [View on Google Patents](${p.url}) |`);
    lines.push("");
    lines.push("**Abstract:**");
    lines.push("");
    lines.push(p.abstract || "_No abstract available_");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  fs.writeFileSync(path.join(RESULTS_DIR, "patents.md"), lines.join("\n"));

  console.log("Saved " + patents.length + " total patents to results/");
}

// ---------------------------------------------------------------------------
// Delta report — written to delta/ folder, one file per run
// Filename: delta_YYYY-MM-DD_to_YYYY-MM-DD.txt (the scraping period)
// ---------------------------------------------------------------------------
const DELTA_DIR = path.join(__dirname, "..", "delta");

function saveDelta(newPatents, config) {
  if (!fs.existsSync(DELTA_DIR)) fs.mkdirSync(DELTA_DIR, { recursive: true });

  const runDate  = new Date().toISOString().slice(0, 10);
  const fromDate = config.afterDate || runDate;
  const toDate   = runDate;
  const filename = `delta_${fromDate}_to_${toDate}.txt`;
  const filepath = path.join(DELTA_DIR, filename);

  const sep = "=".repeat(72);

  const lines = [
    sep,
    "PATENT SCAN DELTA REPORT",
    sep,
    `Run date:      ${new Date().toUTCString()}`,
    `Query:         ${config.query}`,
    `Period:        ${fromDate}  →  ${toDate}`,
    `New patents:   ${newPatents.length}`,
    sep,
    "",
  ];

  if (newPatents.length === 0) {
    lines.push("No new patents found in this period.");
  } else {
    // Group by query so the report is easy to scan
    const byQuery = {};
    newPatents.forEach(p => {
      const q = p.queryLabel || p.query || "unknown query";
      if (!byQuery[q]) byQuery[q] = [];
      byQuery[q].push(p);
    });

    // Summary table at the top
    lines.push("SUMMARY BY QUERY");
    lines.push("-".repeat(72));
    Object.entries(byQuery).forEach(([q, ps]) => {
      lines.push(`  ${ps.length.toString().padStart(3)} patent(s)  →  ${q}`);
    });
    lines.push("");
    lines.push("=".repeat(72));
    lines.push("");

    // Full detail grouped by query
    Object.entries(byQuery).forEach(([q, patents]) => {
      lines.push(`QUERY: "${q}"  (${patents.length} result(s))`);
      lines.push("=".repeat(72));
      lines.push("");
      patents.forEach((p, i) => {
        lines.push(`  PATENT ${i + 1} of ${patents.length}`);
        lines.push(`  Title:            ${p.title || "(no English title)"}`);
        lines.push(`  Patent ID:        ${p.id}`);
        lines.push(`  Country / Office: ${p.country || "—"}`);
        lines.push(`  Type:             ${p.kind || "—"}`);
        lines.push(`  Assignee:         ${p.assignee || "—"}`);
        lines.push(`  Inventor:         ${p.inventor || "—"}`);
        lines.push(`  Priority date:    ${p.priorityDate || "—"}`);
        lines.push(`  Filing date:      ${p.filingDate || "—"}`);
        lines.push(`  Publication date: ${p.pubDate || "—"}`);
        if (p.grantDate) lines.push(`  Grant date:       ${p.grantDate}`);
        lines.push(`  URL:              ${p.url}`);
        lines.push("");
        lines.push("  Abstract:");
        lines.push("  " + (p.abstract || "(no abstract)").split("\n").join("\n  "));
        lines.push("");
        lines.push("  " + "-".repeat(70));
        lines.push("");
      });
    });
  }

  const text = lines.join("\n");
  fs.writeFileSync(filepath, text);
  console.log(`Delta report saved: delta/${filename}`);
  return { filepath, filename, text, fromDate, toDate };
}

// ---------------------------------------------------------------------------
// Email via Gmail SMTP using Node's built-in net/tls (no npm deps needed)
// Uses the same GMAIL_ADDRESS + GMAIL_APP_PASSWORD approach as your other repo.
// ---------------------------------------------------------------------------
function sendEmail({ to, from, subject, body, attachmentPath, attachmentName }) {
  return new Promise((resolve, reject) => {
    const tls  = require("tls");
    const text = body;

    // Build MIME message with attachment
    const boundary = "----=_PatentScannerBoundary_" + Date.now();
    const attachData = fs.readFileSync(attachmentPath);
    const attachB64  = attachData.toString("base64");

    const mime = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      text,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; name="${attachmentName}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${attachmentName}"`,
      ``,
      attachB64,
      `--${boundary}--`,
    ].join("\r\n");

    const b64creds = Buffer.from(`\0${from}\0${process.env.GMAIL_APP_PASSWORD}`).toString("base64");

    let step = 0;
    const commands = [
      null,                                    // wait for greeting
      `EHLO patents-scanner\r\n`,
      `AUTH PLAIN ${b64creds}\r\n`,
      `MAIL FROM:<${from}>\r\n`,
      `RCPT TO:<${to}>\r\n`,
      `DATA\r\n`,
      mime + `\r\n.\r\n`,
      `QUIT\r\n`,
    ];

    const socket = tls.connect(465, "smtp.gmail.com", { servername: "smtp.gmail.com" }, () => {
      // Connected — greeting arrives automatically
    });

    socket.on("data", data => {
      const resp = data.toString();
      // Only advance on positive responses
      if (!/^[23]\d\d/.test(resp.trim())) {
        socket.destroy();
        return reject(new Error("SMTP error: " + resp.trim()));
      }
      step++;
      if (step < commands.length && commands[step]) {
        socket.write(commands[step]);
      } else if (step >= commands.length) {
        resolve();
      }
    });

    socket.on("error", reject);
    socket.setTimeout(30000, () => { socket.destroy(); reject(new Error("SMTP timeout")); });
  });
}

// ---------------------------------------------------------------------------
// Scrape one query — returns array of newly added patents
// ---------------------------------------------------------------------------
async function scrapeQuery(query, config, page, allPatents, existingIds) {
  const qConfig = { ...config, query };
  const newPatents = [];

  const label = query.label ? ` — ${query.label}` : "";
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Query: "${query.query}"${label}`);
  console.log("─".repeat(60));

  for (let pageNum = 0; pageNum < query.maxPages; pageNum++) {
    const searchUrl = buildSearchUrl({ ...qConfig, query: query.query }, pageNum);
    console.log(`  Page ${pageNum + 1}: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("search-result-item", { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await sleep(config.pageDelayMs);

    const pageInfo = await page.evaluate(() => ({
      title:   document.title.slice(0, 70),
      cards:   document.querySelectorAll("search-result-item").length,
      bodyLen: document.body.innerText.length,
    }));
    console.log(`    Page info: cards=${pageInfo.cards} | body=${pageInfo.bodyLen}chars`);

    if (!await pageHasResults(page)) {
      console.log("    No result cards — stopping this query.");
      break;
    }

    const cards = await extractCardsFromPage(page);
    console.log(`    Extracted ${cards.length} cards`);

    for (const card of cards) {
      if (existingIds.has(card.id)) {
        console.log(`    Skip: ${card.id}`);
        continue;
      }

      process.stdout.write(`    ${card.id} | ${(card.title || "?").slice(0, 40).padEnd(40)} | `);
      const abstract = await fetchAbstract(card.url);

      if (abstract) {
        const patent = {
          id: card.id, country: getCountry(card.id), kind: getKind(card.id),
          title: card.title, assignee: card.assignee, inventor: card.inventor,
          priorityDate: card.priorityDate, filingDate: card.filingDate,
          pubDate: card.pubDate, grantDate: card.grantDate,
          url: card.url, abstract,
          query: query.query,          // track which query found this patent
          queryLabel: query.label || query.query,
          scraped_at: new Date().toISOString(),
        };
        allPatents.push(patent);
        newPatents.push(patent);
        existingIds.add(card.id);
        console.log(`✓ (${abstract.length} chars)`);
      } else {
        console.log(`✗ no abstract`);
      }

      await sleep(config.fetchDelayMs);
    }

    saveResults(allPatents);
  }

  console.log(`  → ${newPatents.length} new patent(s) from this query`);
  return newPatents;
}

// ---------------------------------------------------------------------------
// Build structured email body
// ---------------------------------------------------------------------------
function buildEmailBody(newPatents, config, delta) {
  const period  = `${delta.fromDate} &rarr; ${delta.toDate}`;
  const total   = newPatents.length;
  const accent  = "#2c5f2e";
  const light   = "#f5f7f5";

  // Group by query label
  const byQuery = {};
  newPatents.forEach(p => {
    const key = p.queryLabel || p.query || "Unknown";
    if (!byQuery[key]) byQuery[key] = [];
    byQuery[key].push(p);
  });

  const sorted = Object.entries(byQuery).sort((a, b) => b[1].length - a[1].length);
  const maxCount = sorted.length ? sorted[0][1].length : 1;

  // ── Query breakdown rows ───────────────────────────────────────────────────
  const queryRows = sorted.map(([label, patents]) => {
    const pct = Math.round((patents.length / maxCount) * 100);
    return `
      <tr>
        <td style="padding:6px 12px;color:#333;font-size:13px;">${label}</td>
        <td style="padding:6px 12px;width:180px;">
          <div style="background:#e0e0e0;border-radius:3px;height:10px;overflow:hidden;">
            <div style="background:${accent};width:${pct}%;height:10px;border-radius:3px;"></div>
          </div>
        </td>
        <td style="padding:6px 12px;text-align:right;font-weight:600;color:${accent};font-size:13px;">${patents.length}</td>
      </tr>`;
  }).join("");

  // ── Patent preview cards ───────────────────────────────────────────────────
  const preview = newPatents.slice(0, 10);
  const patentCards = preview.map((p, i) => {
    const snippet = p.abstract
      ? p.abstract.slice(0, 220).replace(/\s+/g, " ").trim() + (p.abstract.length > 220 ? "…" : "")
      : "";
    const meta = [p.country, p.kind, p.priorityDate ? `Priority ${p.priorityDate}` : "", p.pubDate ? `Published ${p.pubDate}` : ""]
      .filter(Boolean).join(" &nbsp;·&nbsp; ");

    return `
      <div style="border:1px solid #e0e0e0;border-radius:6px;padding:14px 16px;margin-bottom:10px;background:#fff;">
        <div style="font-size:11px;color:#888;margin-bottom:4px;">${i + 1} &nbsp;·&nbsp; ${meta}</div>
        <div style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:4px;">${p.title || p.id}</div>
        ${p.assignee ? `<div style="font-size:12px;color:#555;margin-bottom:6px;">${p.assignee}</div>` : ""}
        ${snippet    ? `<div style="font-size:12px;color:#444;line-height:1.5;margin-bottom:8px;">${snippet}</div>` : ""}
        <a href="${p.url}" style="font-size:12px;color:${accent};text-decoration:none;">View on Google Patents &rarr;</a>
      </div>`;
  }).join("");

  const moreNote = newPatents.length > 10
    ? `<p style="color:#666;font-size:12px;margin:8px 0 0;">… and ${newPatents.length - 10} more in the attached file.</p>`
    : "";

  const noResultsMsg = total === 0
    ? `<p style="color:#666;font-size:14px;">No new patents found in this period. The full archive is in <code>results/patents.json</code> in the repo.</p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f0f2f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:640px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

  <!-- Header -->
  <div style="background:${accent};padding:24px 28px;">
    <div style="font-size:11px;color:rgba(255,255,255,0.7);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Patent Scanner</div>
    <div style="font-size:26px;font-weight:700;color:#fff;">${total} new patent${total !== 1 ? "s" : ""}</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:4px;">${period}</div>
  </div>

  <!-- Body -->
  <div style="padding:24px 28px;">

    ${noResultsMsg}

    ${total > 0 ? `
    <!-- Stats row -->
    <div style="display:flex;gap:12px;margin-bottom:24px;">
      <div style="flex:1;background:${light};border-radius:6px;padding:12px 16px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:${accent};">${total}</div>
        <div style="font-size:11px;color:#666;margin-top:2px;">New patents</div>
      </div>
      <div style="flex:1;background:${light};border-radius:6px;padding:12px 16px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:${accent};">${config.queries.length}</div>
        <div style="font-size:11px;color:#666;margin-top:2px;">Queries run</div>
      </div>
      <div style="flex:1;background:${light};border-radius:6px;padding:12px 16px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:${accent};">${config.recentDays}d</div>
        <div style="font-size:11px;color:#666;margin-top:2px;">Lookback</div>
      </div>
    </div>

    <!-- Results by query -->
    <h3 style="font-size:13px;font-weight:600;color:#333;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px;">Results by query</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${queryRows}
    </table>

    <!-- Patent previews -->
    <h3 style="font-size:13px;font-weight:600;color:#333;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 12px;">
      Top ${Math.min(10, total)} patent${Math.min(10, total) !== 1 ? "s" : ""}
    </h3>
    ${patentCards}
    ${moreNote}
    ` : ""}

  </div>

  <!-- Footer -->
  <div style="background:${light};padding:14px 28px;border-top:1px solid #e0e0e0;">
    <p style="margin:0;font-size:11px;color:#888;">Full report attached &nbsp;·&nbsp; Archive in <code>results/patents.json</code></p>
  </div>

</div>
</body>
</html>`;
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const config      = loadConfig();
  const existing    = loadExisting();
  const allPatents  = Object.values(existing);
  const existingIds = new Set(Object.keys(existing));

  console.log(`\nPatent Scanner — ${new Date().toUTCString()}`);
  console.log(`Date filter:  last ${config.recentDays} days (after ${config.afterDate})`);
  console.log(`Queries:      ${config.queries.length}`);
  config.queries.forEach((q, i) => console.log(`  ${i + 1}. "${q.query}" (max ${q.maxPages} pages)`));
  console.log(`Existing:     ${allPatents.length} patents already saved`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    locale: "en-US",
  });
  const page = await context.newPage();
  await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}", r => r.abort());

  // Run all queries sequentially, accumulating into one newPatents list
  const allNewPatents = [];
  for (const query of config.queries) {
    const found = await scrapeQuery(query, config, page, allPatents, existingIds);
    allNewPatents.push(...found);
  }

  await browser.close();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`TOTAL: ${allNewPatents.length} new patent(s) across ${config.queries.length} queries`);
  console.log(`Accumulated: ${allPatents.length} patents in results/patents.json`);
  console.log("═".repeat(60));

  // ── Delta report ──────────────────────────────────────────────────────────
  const delta = saveDelta(allNewPatents, config);

  // ── Email ─────────────────────────────────────────────────────────────────
  const gmailAddress  = process.env.GMAIL_ADDRESS;
  const gmailPassword = process.env.GMAIL_APP_PASSWORD;
  const emailTo       = process.env.EMAIL_RECIPIENT || gmailAddress;

  if (gmailAddress && gmailPassword) {
    const subject = allNewPatents.length > 0
      ? `[PatentScanner] ${allNewPatents.length} new patent(s) — ${delta.fromDate} to ${delta.toDate}`
      : `[PatentScanner] No new patents — ${delta.fromDate} to ${delta.toDate}`;

    const body = buildEmailBody(allNewPatents, config, delta);

    try {
      await sendEmail({
        from: gmailAddress, to: emailTo, subject, body,
        attachmentPath: delta.filepath, attachmentName: delta.filename,
      });
      console.log(`Email sent to ${emailTo}`);
    } catch (e) {
      console.error("Email failed:", e.message);
    }
  } else {
    console.log("Email skipped (GMAIL_ADDRESS or GMAIL_APP_PASSWORD not set).");
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
