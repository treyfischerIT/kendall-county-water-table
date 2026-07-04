# Kendall County Texas Water Table Graph

A live, shareable groundwater tracker for the Boerne / Kendall County, Texas area,
built on Texas Water Development Board (TWDB) monitoring well **#6811417**.

**Live site:** https://kendall-county-water-table.trey-817.workers.dev

## What it shows

- An interactive chart of the water table from December 2006 to today (150k+ readings).
- **Inverted depth axis** — the line rising means a *higher* water table (less depth to
  water), which reads intuitively for a general audience. Values are feet below land surface.
- Summary cards: current depth to water, 30-day change, 12-month change, and the change
  since the start of the record.
- A **month-over-month strip** with rise/fall indicators — green ▲ when the water table
  rose that month (water got shallower), red ▼ when it dropped (water got deeper).
- Range toggles: 30 days / 1 year / all-time.

## How it works

The TWDB feed (`/groundwater/well/6811417.json`) is ~33 MB and sends no CORS header, so
a browser can't fetch it directly. A Cloudflare Worker (`src/index.js`) proxies it
server-side at `/api/well`, downsamples it to a small payload (last reading per day, per
month, plus raw last-30-days), adds CORS, and caches the result for one week (the upstream
feed only updates a few times a day). The static page (`public/index.html`, vanilla HTML +
Chart.js) renders it.

## Develop / deploy

```sh
npx wrangler dev      # local preview at http://localhost:8787
npx wrangler deploy   # deploy to Cloudflare Workers
```

Point at a different TWDB well by changing the `id` query param the page requests, e.g.
`/api/well?id=<state-well-number>`.

## Data

Source: Texas Water Development Board, "Water Data for Texas." This is an independent
visualization and is not affiliated with or endorsed by the TWDB.
