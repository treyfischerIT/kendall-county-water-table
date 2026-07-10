#!/usr/bin/env node
// Re-scrape the Cow Creek GCD monitoring map (https://ccgcd.org/monitoring/) for the
// 26 additional Cow Creek GCD monitoring wells and refresh:
//   • public/manual-wells.json        — the per-well depth-to-water series the site loads
//   • const MANUAL_HAS_DATA = [...]    — which manual wells currently have a series
//   • const CHG12_MANUAL = {...}       — each manual well's 12-month change (map color)
// in public/index.html.
//
// The map data is injected client-side (window.markersData), so we render the page with
// headless Chrome via puppeteer-core. On ANY failure the script writes nothing and exits
// non-zero, so a scrape hiccup never blanks the map — the last-good data stays in place.
// Run weekly (see scripts/weekly-update.sh), before/after refresh-droppers.mjs; the two
// touch disjoint constants (CHG12_MANUAL vs CHG12_RECORDER) and never overwrite each other.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = path.join(ROOT, "public/index.html");
const OUT = path.join(ROOT, "public/manual-wells.json");
const URL = "https://ccgcd.org/monitoring/";
// The depth-to-water series is keyed inconsistently across wells — some use
// "Depth to Water", others "Depth to water level". Match either spelling.
const SERIES_RE = /^depth to water/i;
function pickDepthSeries(charts){
  const key = Object.keys(charts || {}).find(
    (k) => SERIES_RE.test(k) && Array.isArray(charts[k]) && charts[k].length
  );
  return key ? charts[key] : [];
}
// Common macOS Chrome/Chromium locations — first that exists wins.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter(Boolean);

function chromePath() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("No Chrome/Chromium found (set CHROME_PATH)");
}

// "MM/DD/YY" -> "YYYY-MM-DD" with a sane 2-digit-year window; null if implausible.
function normDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(s).trim());
  if (!m) return null;
  let [, mm, dd, yy] = m;
  mm = +mm; dd = +dd; yy = +yy;
  if (yy < 100) yy += yy <= 40 ? 2000 : 1900;   // 00–40 -> 20xx, 41–99 -> 19xx
  const nowY = new Date().getFullYear();
  if (yy < 1970 || yy > nowY + 1) return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// The known manual well IDs (m<districtNumber>) come straight from the site config so the
// two never drift. Returns Set of ids like "m4609".
function knownManualIds(html) {
  const arr = [...html.matchAll(/\{id:"(m\d+)"/g)].map((m) => m[1]);
  return new Set(arr);
}

function buildSeries(rawPairs) {
  // rawPairs: [["MM/DD/YY","123.4"], ...] — validate, dedupe by date (keep last), sort.
  const byDate = new Map();
  for (const pair of rawPairs || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const date = normDate(pair[0]);
    const v = parseFloat(pair[1]);
    if (!date || !isFinite(v) || v <= 0 || v >= 2500) continue;
    byDate.set(date, +v.toFixed(2));   // last measurement on a given date wins
  }
  const daily = [...byDate.entries()].map(([date, v]) => ({ date, v })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!daily.length) return null;
  // monthly = last reading in each calendar month
  const monthMap = new Map();
  for (const p of daily) monthMap.set(p.date.slice(0, 7), p);
  const monthly = [...monthMap.entries()].map(([month, p]) => ({ month, date: p.date, v: p.v }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  const cur = daily[daily.length - 1].v;
  const lastMs = new Date(daily[daily.length - 1].date + "T00:00:00").getTime();
  let prev = null;
  for (const p of daily) {
    if (new Date(p.date + "T00:00:00").getTime() <= lastMs - 365 * 864e5) prev = p; else break;
  }
  return {
    current: cur,
    firstDate: daily[0].date,
    lastDate: daily[daily.length - 1].date,
    count: daily.length,
    daily,
    monthly,
    chg12: prev ? +(cur - prev.v).toFixed(1) : null,
  };
}

async function scrape() {
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
    // wait for the plugin to populate window.markersData
    await page.waitForFunction(
      "Array.isArray(window.markersData) && window.markersData.length > 0",
      { timeout: 30000 }
    );
    const markers = await page.evaluate(() => window.markersData);
    if (!Array.isArray(markers) || !markers.length) throw new Error("markersData empty after render");
    return markers;
  } finally {
    await browser.close();
  }
}

(async () => {
  const html = fs.readFileSync(HTML, "utf8");
  const known = knownManualIds(html);
  if (known.size === 0) throw new Error("no manual wells (m<id>) found in index.html");

  const markers = await scrape();

  // id -> built series, restricted to the wells we already track
  const built = {};
  let matched = 0;
  for (const mk of markers) {
    const dn = mk && mk.districtNumber != null ? String(mk.districtNumber).trim() : "";
    if (!dn) continue;
    const id = "m" + dn;
    if (!known.has(id)) continue;
    matched++;
    const charts = mk.charts || {};
    const s = buildSeries(pickDepthSeries(charts));
    if (s) built[id] = s;
  }
  if (matched === 0) throw new Error("no rendered markers matched our manual well ids");

  // 1) manual-wells.json — only wells with a valid series
  const wells = {};
  for (const id of Object.keys(built)) {
    const s = built[id];
    wells[id] = { current: s.current, firstDate: s.firstDate, lastDate: s.lastDate, count: s.count, daily: s.daily, monthly: s.monthly };
  }
  const asof = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: asof, wells }, null, 0));

  // 2) MANUAL_HAS_DATA (which wells have a series) + 3) CHG12_MANUAL (12-mo change for all 26)
  const dataIds = Object.keys(built);
  const hasDataLit = "const MANUAL_HAS_DATA = new Set([" + dataIds.map((i) => JSON.stringify(i)).join(",") + "]);";
  const chgLit = "const CHG12_MANUAL = {" +
    [...known].map((id) => JSON.stringify(id) + ":" + (built[id] && built[id].chg12 != null ? built[id].chg12 : "null")).join(",") +
    "};";

  let out = html;
  const beforeHas = out;
  out = out.replace(/const MANUAL_HAS_DATA = new Set\(\[[^\]]*\]\);/, hasDataLit);
  out = out.replace(/const CHG12_MANUAL = \{[^}]*\};/, chgLit);
  if (out === beforeHas || !out.includes(chgLit)) throw new Error("could not locate MANUAL_HAS_DATA / CHG12_MANUAL to update");
  fs.writeFileSync(HTML, out);

  console.log(`Manual wells refreshed (as of ${asof}): ${dataIds.length}/${known.size} have data.`);
  for (const id of dataIds) console.log(`  ${id}  cur ${built[id].current}  12mo ${built[id].chg12 ?? "—"}  (${built[id].count} pts)`);
  const empty = [...known].filter((id) => !built[id]);
  if (empty.length) console.log(`  no readings yet: ${empty.join(", ")}`);
})().catch((e) => {
  console.error("refresh-manual FAILED (kept previous data):", e.message);
  process.exit(1);
});
