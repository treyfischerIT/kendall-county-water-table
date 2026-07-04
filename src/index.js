// Cloudflare Worker: serves the static page and proxies/aggregates the TWDB
// groundwater feed. The upstream JSON (~8.5MB, no CORS header) is fetched
// server-side, downsampled to a small payload, and cached ~1 hour.

const DEFAULT_WELL = "5758402";
const VALUE_KEY = "water_level(ft below land surface)";
const CACHE_SECONDS = 3600;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/well") {
      return handleWell(request, url, ctx);
    }

    // Everything else = static assets from ./public
    return env.ASSETS.fetch(request);
  },
};

async function handleWell(request, url, ctx) {
  const wellId = (url.searchParams.get("id") || DEFAULT_WELL).replace(/[^0-9]/g, "");
  const cacheKey = new Request(`https://cache.local/well/${wellId}`, { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = `https://waterdatafortexas.org/groundwater/well/${wellId}.json`;
  let raw;
  try {
    const r = await fetch(upstream, {
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    raw = await r.json();
  } catch (err) {
    return json({ error: `Could not load well ${wellId}: ${err.message}` }, 502);
  }

  const payload = aggregate(raw, wellId);
  const resp = json(payload, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
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
