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
const CACHE_SECONDS = 43200; // 12 hours — how often we refresh from TWDB
const EDGE_SECONDS = 2592000; // 30 days — how long the edge keeps a copy (for SWR)
// Bump to invalidate every cached copy at once (e.g. after changing the refresh
// cadence or the payload shape) so all visitors get a fresh rebuild immediately.
const CACHE_VERSION = "v2";

// Only the wells the site actually uses. Prevents the endpoint from being abused
// as an open proxy to hammer TWDB with arbitrary well ids.
const ALLOWED_WELLS = new Set(["6811417", "6810616"]);
const DEFAULT_WELL = "6811417";

// Per-isolate map of in-flight builds — the thundering-herd guard.
const inflight = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/well") {
      return handleWell(url, ctx);
    }

    // Everything else = static assets from ./public
    return env.ASSETS.fetch(request);
  },
};

async function handleWell(url, ctx) {
  const requested = (url.searchParams.get("id") || DEFAULT_WELL).replace(/[^0-9]/g, "");
  if (!ALLOWED_WELLS.has(requested)) {
    return json({ error: `Unknown well ${requested || "(none)"}` }, 404, {
      "Cache-Control": "public, max-age=3600",
    });
  }
  const wellId = requested;
  const cacheKey = new Request(`https://cache.local/well/${CACHE_VERSION}/${wellId}`, { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    // Serve immediately. If it's past the refresh mark, rebuild in the
    // background so the next visitor gets fresh data — this request doesn't wait.
    const builtAt = Number(cached.headers.get("x-built-at")) || 0;
    if (Date.now() - builtAt > CACHE_SECONDS * 1000) {
      ctx.waitUntil(refresh(wellId, cache, cacheKey));
    }
    return cached;
  }

  // Cold: build synchronously (dedup'd so concurrent cold requests share one build).
  let payload;
  try {
    payload = await buildPayload(wellId);
  } catch (err) {
    return json({ error: `Could not load well ${wellId}: ${err.message}` }, 502);
  }
  const resp = freshResponse(payload);
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
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

// Background revalidation: rebuild and replace the cached copy. On failure we do
// nothing, so the existing (stale) copy keeps being served — stale-if-error.
async function refresh(wellId, cache, cacheKey) {
  try {
    const payload = await buildPayload(wellId);
    await cache.put(cacheKey, freshResponse(payload));
  } catch (_) {
    /* keep serving the last good copy */
  }
}

function freshResponse(payload) {
  return json(payload, 200, {
    // Browsers cache a week; the edge holds a copy for 30 days so we can serve
    // stale-while-revalidate and stale-if-error from it.
    "Cache-Control":
      `public, max-age=${CACHE_SECONDS}, s-maxage=${EDGE_SECONDS}, ` +
      `stale-while-revalidate=${EDGE_SECONDS}, stale-if-error=${EDGE_SECONDS}`,
    "x-built-at": String(Date.now()),
  });
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
