// Cloudflare Worker: serves the static page and proxies/aggregates the TWDB
// groundwater feed. The upstream JSON (~8-33MB, no CORS header) is fetched
// server-side, downsampled to a small payload, and heavily cached so the site
// stays cheap and fast even under a viral traffic spike.
//
// Caching layers (fastest → slowest), so almost no request ever touches TWDB:
//   1. Browser cache        — max-age, one API hit per visitor per refresh window.
//   2. Cloudflare edge cache — caches.default, shared across all visitors in a colo.
//   3. Stale-while-revalidate — past the refresh mark we serve the stale copy
//      instantly and rebuild in the background; a spike never waits on a rebuild.
//   4. In-isolate dedup      — a burst of cold requests shares ONE fetch+parse
//      instead of each downloading and parsing the multi-MB feed.
//   5. stale-if-error        — if TWDB is down, keep serving the last good copy.

const VALUE_KEY = "water_level(ft below land surface)";
// Refresh from TWDB about twice a day. The source posts a new reading roughly
// once daily, so a 12h window reliably picks up each update within half a day
// without over-fetching. SWR means users never wait on the refetch.
const CACHE_SECONDS = 86400; // 24 hours — how often we refresh from TWDB (source posts ~once daily)
const EDGE_SECONDS = 2592000; // 30 days — how long the edge keeps a copy (for SWR)
// Bump to invalidate every cached copy at once (e.g. after changing the refresh
// cadence or the payload shape) so all visitors get a fresh rebuild immediately.
const CACHE_VERSION = "v3";

// Only the wells the site actually uses (the Cow Creek GCD monitoring network).
// Prevents the endpoint from being abused as an open proxy to hammer TWDB with
// arbitrary well ids.
const ALLOWED_WELLS = new Set([
  "6811417", "6810616", "5758203", "6811708", "6806105", "6801314", "6811302",
  "5758402", "6804214", "6812414", "6802302", "6803503", "6804312", "6810626",
  "6811817", "6812106", "6802807", "6803109", "6811509", "6809303", "6811418",
  "6802609", "6802509",
  // San Antonio groundwater pilot — Edwards + Trinity recorder wells (Bexar Co).
  "6836132", "6828211", "6827610", "6829112", "6827609",
  "6819806", "6827112", "6820110", "6820602", "6819618",
  // Groundwater rollout — recorder wells for Austin, Houston, DFW, Amarillo, Kerrville.
  "5835811", "5857502", "5748811", "5748505", "5826312", "5756716", "5748109", "5747312", "5747314",
  "6514738", "6514746", "6514409", "6521230", "6522622", "6523322", "6512726", "6512725", "6512729", "6507909",
  "3325202", "3319101", "3231906", "3333203", "3326822", "3333304", "3334207", "3334209", "3240703", "3240704",
  "0635912", "0653401", "0637710", "0646805",
  "5663922", "6801703", "6801704", "5654405", "6806105", "5750108", "6924225", "6802302", "5750324", "6803109",
  // Hill Country groundwater (New Braunfels, Fredericksburg, Wimberley, San Marcos, Killeen-Temple).
  "6815211", "5764721", "5764705", "6733805", "5763705", "5763504", "5764405", "6733907", "5764502", "5663923",
  "5755607", "5755405", "6711501", "4061509", "5804702", "5804816", "4062501", "4058201", "5802304", "5802303",
  "5803702", "5803701", "4057601",
  // Central/East Texas groundwater (Waco, Tyler-Longview).
  "4039204", "4014602", "4015102", "4007502", "3541604", "3430907", "3558405", "3552602",
]);
const DEFAULT_WELL = "6811417";

// USGS real-time stream gauges, allowlisted per region so /api/streams can't be
// used as an open proxy to USGS. Pick a region with ?region= (default boerne).
const STREAM_SITE_SETS = {
  // Boerne / Kendall County: Cibolo, Guadalupe, Cypress.
  boerne: "08183900,08183978,08184050,08166700,08166250,08167000,08167200,08167500",
  // Lampasas County area: Lampasas Rv, Colorado Rv, Cowhouse/House/Rocky Cks, San Gabriel.
  lampasas: "08102850,08103800,08147000,08100950,08101000,08101310,08103900,08104590",
  // Statewide city pages (served by /city.html via CITY_SLUGS routing below).
  "austin": "08157560,08157540,08156800,08155400,08158035,08155541,08158030,08155300",
  "san-antonio": "08178000,08178500,08178050,08177700,08178800,08181447,08181460,08181445",
  "houston": "08074598,08074500,08074540,08074000,08075110,08075763,08074710,08075000",
  "dfw": "0804956950,08049500,08049300,08050100,08055560,08055605,08048800,08055518",
  "corpus-christi": "08211520,08211500,08211502,08189718,08212820,08211200,08189520",
  "new-braunfels": "08169000,08168913,08168932,08169500,08168500,08168797,08167900,08168770",
  "san-marcos": "08170500,08171350,08171300,08171400,08171290,08171000,08158700,08167900",
  "kerrville": "08166200,08166150,08166140,08166250,08166000,08166700,08165500,08165300",
  "fredericksburg": "08152900,08166700,08167000,08166200,08166150,08166140,08166250,08170800",
  "wimberley": "08171000,08170950,08170905,08158700,08171290,08167800,08171300,08170500",
  "san-angelo": "08136000,08134250,08131400,08130700,08128030,08128400,08130500,08124000",
  "abilene": "08083420,08083480,08083430,08083240,08086050,08084800,08086212,08080500",
  "amarillo": "07227500,07295400,07227700,07295500,07297910,07227890",
  "wichita-falls": "07312610,07312500,07312330,07308500,07314900,07314500,07312200,07312110",
  "waco": "08096500,08096580,08095400,08095300,08097000,08093100,08095200,08093360",
  "killeen-temple": "08102595,08104100,08102500,08104300,08100700,08104500,08101330,08101340",
  "college-station": "08111051,08109310,08111006,08111056,08108700,08110100,08111070,08110000",
  "tyler-longview": "08020700,08020000,08020450,08019200,08019500,08020900,08034500,07346050",
  "beaumont": "08041790,08041788,08041780,08042468,08041749,08042515,08031005,08041940",
  "victoria": "08176500,08177500,08177520,08176900,08188570,08177300,08188500,08175800",
  "laredo": "08458995,08458993,08458975,08458980,08194200",
  "brownsville": "08474107,08474095,08474108,08474110,08474115,08474300,08474320,08474118",
};
// The statewide city slugs are served by the shared /city.html template.
const CITY_SLUGS = new Set([
  "austin","san-antonio","houston","dfw","corpus-christi",
  "new-braunfels","san-marcos","kerrville","fredericksburg","wimberley",
  "san-angelo","abilene","amarillo","wichita-falls","waco","killeen-temple","college-station","tyler-longview","beaumont","victoria","laredo","brownsville",
]);
const STREAM_PERIODS = new Set(["P1D", "P7D", "P30D"]);
// Bounding box (west,south,east,north) for daily rainfall stations per region.
const RAIN_BBOX = {
  boerne: "-99.15,29.50,-98.30,30.20",
  lampasas: "-98.53,30.71,-97.83,31.41",
  "austin": "-98.09,29.92,-97.39,30.62",
  "san-antonio": "-98.84,29.07,-98.14,29.77",
  "houston": "-95.72,29.41,-95.02,30.11",
  "dfw": "-97.40,32.45,-96.70,33.15",
  "corpus-christi": "-97.75,27.45,-97.05,28.15",
  "new-braunfels": "-98.47,29.35,-97.77,30.05",
  "san-marcos": "-98.29,29.53,-97.59,30.23",
  "kerrville": "-99.49,29.70,-98.79,30.40",
  "fredericksburg": "-99.22,29.93,-98.52,30.63",
  "wimberley": "-98.45,29.65,-97.75,30.35",
  "san-angelo": "-100.7870,31.1138,-100.0870,31.8138",
  "abilene": "-100.0831,32.0987,-99.3831,32.7987",
  "amarillo": "-102.1813,34.8720,-101.4813,35.5720",
  "wichita-falls": "-98.8434,33.5637,-98.1434,34.2637",
  "waco": "-97.4967,31.1993,-96.7967,31.8993",
  "killeen-temple": "-97.9,30.73,-97.2,31.43",
  "college-station": "-96.6844,30.278,-95.9844,30.978",
  "tyler-longview": "-95.4,32.0,-94.7,32.7",
  "beaumont": "-94.4766,29.7302,-93.7766,30.4302",
  "victoria": "-97.3536,28.4553,-96.6536,29.1553",
  "laredo": "-99.8303,27.1806,-99.1303,27.8806",
  "brownsville": "-97.8475,25.5517,-97.1475,26.2517",
};

// Per-isolate map of in-flight builds — the thundering-herd guard.
const inflight = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/well") {
      return handleWell(url, ctx, env);
    }
    if (url.pathname === "/api/streams") {
      return handleStreams(url, ctx);
    }
    if (url.pathname === "/api/rain") {
      return handleRain(url, ctx);
    }

    // Statewide city pages share one template served at their slug URL.
    // Fetch the extensionless path (not /city.html) so the static-assets
    // html_handling doesn't 307-redirect the internal fetch and leak the
    // wrong (default) city to the browser.
    const slug = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (CITY_SLUGS.has(slug)) {
      const res = await env.ASSETS.fetch(new Request(new URL("/city", url), request));
      return injectCommon(new Response(res.body, res), url.pathname);
    }

    // Boerne is an alias for the Kendall County flagship (groundwater) page,
    // so town-name traffic resolves to the same content at /kendall.
    if (slug === "boerne") {
      const res = await env.ASSETS.fetch(new Request(new URL("/kendall", url), request));
      return injectCommon(new Response(res.body, res), url.pathname);
    }

    // Everything else = static assets from ./public
    return injectCommon(await env.ASSETS.fetch(request), url.pathname);
  },
};

// Inject the shared site include (/tww-common.js) into every HTML response, so
// the disclaimer banner + mid-page ad land on every current AND future page with
// zero per-page markup. Non-HTML responses (JSON API, the JS/asset files) pass
// through untouched.
// City pages that carry a groundwater/water-table section (see WELLSETS in city.html).
const GW_CITY_SLUGS = new Set([
  "san-antonio", "austin", "houston", "dfw", "amarillo", "kerrville",
  "new-braunfels", "fredericksburg", "wimberley", "san-marcos", "killeen-temple",
  "waco", "tyler-longview",
]);

// Every place, for the "Jump to a city" nav dropdown.
const CITY_NAV = [
  { href: "/kendall", name: "Boerne · Kendall" },
  { href: "/new-braunfels", name: "New Braunfels" },
  { href: "/san-marcos", name: "San Marcos" },
  { href: "/wimberley", name: "Wimberley & Blanco" },
  { href: "/kerrville", name: "Kerrville" },
  { href: "/fredericksburg", name: "Fredericksburg" },
  { href: "/lampasas", name: "Lampasas" },
  { href: "/austin", name: "Austin" },
  { href: "/san-antonio", name: "San Antonio" },
  { href: "/houston", name: "Houston" },
  { href: "/dfw", name: "Dallas–Fort Worth" },
  { href: "/corpus-christi", name: "Corpus Christi" },
  { href: "/san-angelo", name: "San Angelo" },
  { href: "/abilene", name: "Abilene" },
  { href: "/amarillo", name: "Amarillo" },
  { href: "/wichita-falls", name: "Wichita Falls" },
  { href: "/waco", name: "Waco" },
  { href: "/killeen-temple", name: "Killeen–Temple" },
  { href: "/college-station", name: "Bryan–College Station" },
  { href: "/tyler-longview", name: "Tyler–Longview" },
  { href: "/beaumont", name: "Beaumont–Port Arthur" },
  { href: "/victoria", name: "Victoria" },
  { href: "/laredo", name: "Laredo" },
  { href: "/brownsville", name: "Brownsville" },
];

// Cross-site nav injected server-side (crawlable, no flash) into every page.
// On a city page the data views live in one page, so Water table / Rainfall /
// Creeks link to that city's own sections; elsewhere they link to the standalone
// Boerne-area pages. A "Jump to a city" dropdown lets you hop anywhere.
function navFor(pathname) {
  const p = (pathname || "/").replace(/\/+$/, "") || "/";
  const slug = p.replace(/^\/+/, "");
  const isCity = CITY_SLUGS.has(slug);
  // The standalone Boerne/Kendall data pages (these cross-link each other).
  const FLAGSHIP = new Set(["/kendall", "/boerne", "/rain", "/streams"]);
  const items = [{ href: "/", label: "🏠 Home", key: "/" }];
  if (isCity) {
    // A city page holds its data in-page — jump to that city's own sections.
    // Only show Water table where the city actually has a groundwater section.
    if (GW_CITY_SLUGS.has(slug)) items.push({ href: "#gwSection", label: "💧 Water table" });
    items.push({ href: "#rainSection", label: "🌧️ Rainfall" });
    items.push({ href: "#streamsSection", label: "🌊 Creeks & rivers" });
  } else if (FLAGSHIP.has(p)) {
    // Boerne/Kendall flagship pages cross-link their sibling views.
    items.push({ href: "/kendall", label: "💧 Water table", key: "/kendall" });
    items.push({ href: "/rain", label: "🌧️ Rainfall", key: "/rain" });
    items.push({ href: "/streams", label: "🌊 Creeks & rivers", key: "/streams" });
  }
  // Otherwise (statewide hub, /lampasas, /rain-almanac, /privacy): just Home + the
  // city picker, so these links never funnel a statewide visitor to Kendall County.
  const links = items
    .map((it) => {
      const active = !isCity && (p === it.key || (it.key === "/kendall" && p === "/boerne"));
      return (
        `<a href="${it.href}"${active ? ' aria-current="page"' : ""} ` +
        `style="color:${active ? "#38bdf8" : "#c3d4e4"};text-decoration:none;padding:2px 0;` +
        `border-bottom:1px solid ${active ? "#38bdf8" : "rgba(147,170,191,.35)"};` +
        `font-weight:${active ? "600" : "400"};white-space:nowrap">${it.label}</a>`
      );
    })
    .join("");
  const cityLinks = CITY_NAV.map((c) => {
    const cur = c.href === p;
    return (
      `<a href="${c.href}" style="color:${cur ? "#38bdf8" : "#c3d4e4"};text-decoration:none;` +
      `padding:5px 8px;border-radius:6px;white-space:nowrap${cur ? ";font-weight:600" : ""}">${c.name}</a>`
    );
  }).join("");
  const drop =
    '<details style="position:relative">' +
    '<summary style="cursor:pointer;list-style:none;color:#eaf2fb;font-weight:600;' +
    'padding:2px 0;border-bottom:1px solid rgba(56,189,248,.55)">📍 Jump to a city ▾</summary>' +
    '<div style="position:absolute;top:calc(100% + 10px);right:0;z-index:3000;background:#0f2032;' +
    'border:1px solid rgba(147,174,199,.3);border-radius:12px;padding:12px;display:grid;' +
    'grid-template-columns:repeat(2,minmax(150px,1fr));gap:2px 12px;min-width:320px;max-width:92vw;' +
    'max-height:min(70vh,520px);overflow:auto;box-shadow:0 18px 44px rgba(0,0,0,.55)">' +
    cityLinks +
    "</div></details>";
  return (
    '<nav id="tww-nav" aria-label="Texas Water Watchers" ' +
    'style="background:rgba(56,189,248,.07);border-bottom:1px solid rgba(56,189,248,.30)">' +
    '<div style="max-width:1080px;margin:0 auto;display:flex;gap:10px 22px;flex-wrap:wrap;' +
    "align-items:center;justify-content:space-between;" +
    'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.72rem;letter-spacing:.05em;' +
    'padding:12px clamp(16px,4vw,36px)">' +
    '<span style="display:flex;gap:6px 22px;flex-wrap:wrap;align-items:center">' +
    links +
    "</span>" +
    drop +
    "</div></nav>"
  );
}

function injectCommon(response, pathname) {
  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return response;
  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append('<script defer src="/tww-common.js"></script>', { html: true });
      },
    })
    .on("body", {
      element(el) {
        el.prepend(navFor(pathname), { html: true });
      },
    })
    .transform(response);
}

async function handleWell(url, ctx, env) {
  const requested = (url.searchParams.get("id") || DEFAULT_WELL).replace(/[^0-9]/g, "");
  if (!ALLOWED_WELLS.has(requested)) {
    return json({ error: `Unknown well ${requested || "(none)"}` }, 404, {
      "Cache-Control": "public, max-age=3600",
    });
  }
  const wellId = requested;
  const cacheKey = new Request(`https://cache.local/well/${CACHE_VERSION}/${wellId}`, { method: "GET" });
  const cache = caches.default;

  // 1. Edge cache (fastest, per-colo).
  const cached = await cache.match(cacheKey);
  if (cached) {
    const builtAt = Number(cached.headers.get("x-built-at")) || 0;
    if (Date.now() - builtAt > CACHE_SECONDS * 1000) {
      ctx.waitUntil(refresh(env, wellId, cache, cacheKey));
    }
    return cached;
  }

  // 2. R2 archive (durable, tiny read) — avoids re-pulling the ~33MB TWDB feed.
  //    Serve the stored payload instantly; if it's past the refresh window,
  //    rebuild from TWDB in the background so no visitor ever waits on the big fetch.
  if (env && env.WATER_DATA) {
    try {
      const obj = await env.WATER_DATA.get(r2Key(wellId));
      if (obj) {
        const payload = await obj.json();
        const builtAt = Number(obj.customMetadata && obj.customMetadata.builtAt) ||
          (obj.uploaded ? obj.uploaded.getTime() : 0);
        const resp = payloadResponse(payload, builtAt, "r2");
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        if (Date.now() - builtAt > CACHE_SECONDS * 1000) {
          ctx.waitUntil(refresh(env, wellId, cache, cacheKey));
        }
        return resp;
      }
    } catch (_) {
      /* R2 hiccup — fall through to the upstream build */
    }
  }

  // 3. Cold: build from TWDB (dedup'd), then seed both the edge cache and R2.
  let payload;
  try {
    payload = await buildPayload(wellId);
  } catch (err) {
    return json({ error: `Could not load well ${wellId}: ${err.message}` }, 502);
  }
  const resp = payloadResponse(payload, Date.now(), "upstream");
  ctx.waitUntil(Promise.all([cache.put(cacheKey, resp.clone()), r2Put(env, wellId, payload)]));
  return resp;
}

// Fetch + aggregate the upstream feed, deduplicating concurrent calls for the
// same well within this isolate so a burst only does the work once.
function buildPayload(wellId) {
  let job = inflight.get(wellId);
  if (!job) {
    job = (async () => {
      const upstream = `https://waterdatafortexas.org/groundwater/well/${wellId}.json`;
      // Bypass Cloudflare's cache for the raw feed so each (rare, deduped, at most
      // once per refresh window per colo) rebuild gets genuinely fresh readings.
      const r = await fetch(upstream, { cache: "no-store" });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      return aggregate(await r.json(), wellId);
    })().finally(() => inflight.delete(wellId));
    inflight.set(wellId, job);
  }
  return job;
}

// Background revalidation: rebuild from TWDB and replace both the edge copy and
// the durable R2 copy. On failure we do nothing, so the existing (stale) copies
// keep being served — stale-if-error.
async function refresh(env, wellId, cache, cacheKey) {
  try {
    const payload = await buildPayload(wellId);
    await Promise.all([
      cache.put(cacheKey, payloadResponse(payload, Date.now(), "upstream")),
      r2Put(env, wellId, payload),
    ]);
  } catch (_) {
    /* keep serving the last good copy */
  }
}

function payloadResponse(payload, builtAt, source) {
  return json(payload, 200, {
    // Browsers cache a day; the edge holds a copy for 30 days so we can serve
    // stale-while-revalidate and stale-if-error from it.
    "Cache-Control":
      `public, max-age=${CACHE_SECONDS}, s-maxage=${EDGE_SECONDS}, ` +
      `stale-while-revalidate=${EDGE_SECONDS}, stale-if-error=${EDGE_SECONDS}`,
    "x-built-at": String(builtAt || Date.now()),
    "x-source": source || "upstream",
  });
}

// Durable archive of the downsampled historic payload, keyed by cache version so
// a payload-shape change rolls over cleanly.
function r2Key(wellId) {
  return `well/${CACHE_VERSION}/${wellId}.json`;
}
async function r2Put(env, wellId, payload) {
  if (!env || !env.WATER_DATA) return;
  try {
    await env.WATER_DATA.put(r2Key(wellId), JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { builtAt: String(Date.now()) },
    });
  } catch (_) {
    /* archival is best-effort; serving never depends on the write succeeding */
  }
}

// Turn the full record into a compact payload:
//   monthly: last reading per calendar month  -> MoM indicators + all-time view
//   daily:   last reading per calendar day     -> chart lines (all / 1y)
//   recent:  raw readings from the last 30 days -> 30-day view
function aggregate(raw, wellId) {
  const rows = (raw.values || [])
    .map((v) => ({ t: v.datetime, v: v[VALUE_KEY] }))
    .filter((r) => r.t && typeof r.v === "number")
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)); // ascending

  const dailyMap = new Map();
  const monthlyMap = new Map();
  for (const r of rows) {
    const day = r.t.slice(0, 10); // YYYY-MM-DD
    const month = r.t.slice(0, 7); // YYYY-MM
    dailyMap.set(day, r.v); // last wins (rows are ascending)
    monthlyMap.set(month, { date: day, v: r.v });
  }

  const daily = [...dailyMap.entries()].map(([date, v]) => ({ date, v }));
  const monthly = [...monthlyMap.entries()].map(([month, o]) => ({
    month,
    date: o.date,
    v: o.v,
  }));

  const last = rows[rows.length - 1] || null;
  let recent = [];
  if (last) {
    const cutoff = new Date(last.t.replace(" ", "T") + "Z").getTime() - 30 * 864e5;
    recent = rows
      .filter((r) => new Date(r.t.replace(" ", "T") + "Z").getTime() >= cutoff)
      .map((r) => ({ t: r.t, v: r.v }));
  }

  return {
    wellId,
    unit: "ft below land surface",
    updated: last ? last.t : null,
    current: last ? last.v : null,
    count: rows.length,
    firstDate: rows.length ? rows[0].t : null,
    lastDate: last ? last.t : null,
    monthly,
    daily,
    recent,
  };
}

// --- Streams (USGS) and rainfall (ACIS) — cached, viral-safe proxies ---------
// Both external feeds are fetched server-side and cached at the edge with
// stale-while-revalidate, so visitors hit our edge, not the upstream API, and a
// spike never waits on a rebuild. Same pattern as the well endpoint above.

async function handleStreams(url, ctx) {
  let period = (url.searchParams.get("period") || "P7D").toUpperCase();
  if (!STREAM_PERIODS.has(period)) period = "P7D";
  const reqRegion = url.searchParams.get("region");
  const region = STREAM_SITE_SETS[reqRegion] ? reqRegion : "boerne";
  const sites = STREAM_SITE_SETS[region];
  const key = new Request(`https://cache.local/streams/${CACHE_VERSION}/${region}/${period}`);
  // USGS fair-use guidance (waterservices.usgs.gov docs): small requests should
  // stay under ~5-10/sec steady; offenders get HTTP 429. Gauge readings are
  // taken ~every 15 min and transmitted about hourly. With this edge cache we
  // hit USGS at most once per 5 min per period per colo — orders of magnitude
  // under the limit — and every visitor is served from our edge, never USGS.
  // NOTE: waterservices.usgs.gov is slated for decommission in early 2027;
  // migrate this URL to api.waterdata.usgs.gov (OGC API) before then.
  return cachedJson(key, 300, async () => {
    const u =
      `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${sites}` +
      `&parameterCd=00065,00060&period=${period}&siteStatus=all`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) throw new Error(`USGS ${r.status}`);
    return await r.json();
  }, ctx);
}

async function handleRain(url, ctx) {
  const reqRegion = url.searchParams.get("region");
  const region = RAIN_BBOX[reqRegion] ? reqRegion : "boerne";
  const bbox = RAIN_BBOX[region];
  const [bw, bs, be, bn] = bbox.split(",").map(Number);
  const center = [(bs + bn) / 2, (bw + be) / 2]; // region center, for the distance filter
  const key = new Request(`https://cache.local/rain/${CACHE_VERSION}/${region}`);
  // Daily totals from the CoCoRaHS/COOP networks via ACIS. They trickle in
  // through the morning, so an hourly refresh is plenty.
  return cachedJson(key, 3600, async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 13 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    const params = JSON.stringify({
      bbox: bbox,
      sdate: iso(start),
      edate: iso(end),
      elems: "pcpn",
      meta: "name,ll,sids,county",
    });
    const u = `https://data.rcc-acis.org/MultiStnData?params=${encodeURIComponent(params)}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`ACIS ${r.status}`);
    const raw = await r.json();

    // Dates line up positionally with each station's data array (sdate..edate).
    const dates = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 864e5) dates.push(iso(new Date(t)));
    const BO = center; // region center (derived from the region's rainfall bbox)
    const miDist = (la, lo) => {
      const R = 3958.8, r = Math.PI / 180;
      const a = Math.sin((la - BO[0]) * r / 2) ** 2 +
        Math.cos(BO[0] * r) * Math.cos(la * r) * Math.sin((lo - BO[1]) * r / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    // ACIS precip codes: 'M' missing, 'T' trace, values may carry a flag letter.
    const pcp = (v) => {
      if (v == null || v === "M") return null;
      if (v === "T") return 0.002;
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    };
    const stations = [];
    for (const s of raw.data || []) {
      const ll = s.meta && s.meta.ll;
      if (!ll) continue;
      const lon = ll[0], lat = ll[1];
      const d = miDist(lat, lon);
      if (d > 24) continue; // keep it Boerne-area
      const vals = (s.data || []).map((x) => pcp(Array.isArray(x) ? x[0] : x));
      if (!vals.slice(-3).some((v) => v != null)) continue; // must have reported recently
      stations.push({
        name: s.meta.name,
        lat: +lat.toFixed(4),
        lon: +lon.toFixed(4),
        dist: +d.toFixed(1),
        vals,
      });
    }
    const total = (v) => v.reduce((a, b) => a + (b || 0), 0);
    stations.sort((a, b) => total(b.vals) - total(a.vals)); // wettest first
    return { updated: iso(end), dates, stations: stations.slice(0, 30) };
  }, ctx);
}

// Generic edge-cached JSON with background revalidation past the TTL.
async function cachedJson(cacheKey, ttlSec, builder, ctx) {
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const builtAt = Number(cached.headers.get("x-built-at")) || 0;
    if (Date.now() - builtAt > ttlSec * 1000) {
      ctx.waitUntil(
        (async () => {
          try {
            await cache.put(cacheKey, cachedResponse(await builder(), ttlSec));
          } catch (_) {
            /* keep serving the last good copy — stale-if-error */
          }
        })(),
      );
    }
    return cached;
  }
  let payload;
  try {
    payload = await builder();
  } catch (e) {
    return json({ error: e.message }, 502, { "Cache-Control": "public, max-age=30" });
  }
  const resp = cachedResponse(payload, ttlSec);
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

function cachedResponse(payload, ttlSec) {
  return json(payload, 200, {
    "Cache-Control":
      `public, max-age=${ttlSec}, s-maxage=${EDGE_SECONDS}, ` +
      `stale-while-revalidate=${EDGE_SECONDS}, stale-if-error=${EDGE_SECONDS}`,
    "x-built-at": String(Date.now()),
  });
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...extra,
    },
  });
}
