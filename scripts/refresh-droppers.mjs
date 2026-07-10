#!/usr/bin/env node
// Recompute each well's 12-month change in depth-to-water and write the fresh
// values into public/index.html (CHG12 + CHG12_ASOF) and wells-catalog.json.
// Run weekly (see scripts/weekly-update.sh). On any single-well fetch failure it
// keeps that well's previous value so a hiccup never blanks the map.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAT = path.join(ROOT, "wells-catalog.json");
const HTML = path.join(ROOT, "public/index.html");
const KEY = "water_level(ft below land surface)";
// Fetch wells one at a time with a pause between each, so we never hit the TWDB
// server with a burst of simultaneous requests (avoids rate-limiting/throttling).
const THROTTLE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cat = JSON.parse(fs.readFileSync(CAT, "utf8"));
const result = {};

for (const w of cat.wells) {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 90000);
    const r = await fetch(`https://waterdatafortexas.org/groundwater/well/${w.id}.json`, { signal: ctl.signal });
    clearTimeout(to);
    const raw = await r.json();
    const rows = (raw.values || [])
      .map((v) => ({ t: v.datetime, v: v[KEY] }))
      .filter((x) => x.t && typeof x.v === "number")
      .sort((a, b) => (a.t < b.t ? -1 : 1));
    if (!rows.length) { result[w.id] = null; continue; }
    const cur = rows[rows.length - 1].v;
    const lastMs = new Date(rows[rows.length - 1].t.replace(" ", "T")).getTime();
    let prev = null;
    for (const p of rows) {
      if (new Date(p.t.replace(" ", "T")).getTime() <= lastMs - 365 * 864e5) prev = p; else break;
    }
    result[w.id] = prev ? +(cur - prev.v).toFixed(1) : null;
    console.log(w.id, w.ccgcdName, result[w.id]);
  } catch (e) {
    console.error(w.id, w.ccgcdName, "ERR", e.message, "(keeping previous value)");
    result[w.id] = w.change12moFt ?? null;
  } finally {
    await sleep(THROTTLE_MS); // pace requests — one well at a time, spaced out
  }
}

const asof = new Date().toISOString().slice(0, 10);

// 1) catalog cache
cat.chg12UpdatedAt = asof;
for (const w of cat.wells) w.change12moFt = result[w.id] ?? null;
fs.writeFileSync(CAT, JSON.stringify(cat, null, 2));

// 2) site
let html = fs.readFileSync(HTML, "utf8");
// Only the recorder half — the 26 CCGCD map wells live in CHG12_MANUAL,
// refreshed separately by refresh-manual.mjs, and must not be touched here.
const lit = "const CHG12_RECORDER = {" +
  cat.wells.map((w) => JSON.stringify(w.id) + ":" + (result[w.id] == null ? "null" : result[w.id])).join(",") +
  "};";
html = html.replace(/const CHG12_RECORDER = \{[^}]*\};/, lit);
html = html.replace(/const CHG12_ASOF = "[^"]*";/, `const CHG12_ASOF = "${asof}";`);
fs.writeFileSync(HTML, html);

console.log(`\nUpdated 12-month change for ${cat.wells.length} wells (as of ${asof}).`);
