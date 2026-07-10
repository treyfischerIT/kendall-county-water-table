# Weekly groundwater refresh

The map shows **49 wells**: 23 automatic hourly recorders (TWDB feeds) + 26 additional
Cow Creek GCD monitoring wells (all with a published series).
Each is colored by its **12-month change in depth-to-water**:

| Color | Meaning |
|---|---|
| 🔴 Red (larger dot) | Dropped 15+ ft in 12 months (dramatic) |
| 🟠 Amber | Dropped 5–15 ft |
| 🔵 Blue | Roughly stable (±5 ft) |
| 🟢 Green | Recovered 5+ ft |
| ⚪ Gray | Not enough record yet |

Those values live in `public/index.html`, split into two constants that two separate jobs
own so they never overwrite each other, merged into `CHG12` at runtime:

- **`CHG12_RECORDER`** (23 recorders) + `CHG12_ASOF` — the recorder snapshot date.
- **`CHG12_MANUAL`** (26 manual wells) — plus `MANUAL_HAS_DATA` (which have a series).

Recorder values are also cached in `wells-catalog.json`; the manual series live in
`public/manual-wells.json` (loaded lazily by the site when a manual well is selected).

## How it updates (weekly, automatic)

Two scripts, run back-to-back by `scripts/weekly-update.sh`:

1. **`scripts/refresh-droppers.mjs`** — refetches each of the 23 TWDB feeds (one at a time,
   1s apart, to avoid throttling), recomputes the 12-month change, and rewrites
   `CHG12_RECORDER`/`CHG12_ASOF` in `index.html` + the catalog. On a single-well fetch
   failure it keeps that well's previous value. **Fatal** if the whole job errors.
2. **`scripts/refresh-manual.mjs`** — renders `https://ccgcd.org/monitoring/` with headless
   Chrome (`puppeteer-core` + system Chrome; `window.markersData` is client-injected),
   re-extracts the "Depth to Water" series for the 26 CCGCD map wells, and rewrites
   `public/manual-wells.json`, `MANUAL_HAS_DATA`, and `CHG12_MANUAL`. It writes **nothing**
   on failure (keeps last-good data) and is treated as **non-fatal** by the weekly job, so a
   scrape hiccup never blanks the map and the recorder refresh still deploys.
   Needs Chrome — override the path with `CHROME_PATH=/path/to/chrome` if it moves.

`weekly-update.sh` runs both, then `npx wrangler deploy`, then a **local** git commit (it
does not `git push` — that stays manual).

A launchd agent runs it **every Monday at 7:00 AM**:
`~/Library/LaunchAgents/com.texaswaterwatchers.weekly.plist`

## Manual run
```sh
cd ~/kendall-county-water-table
node scripts/refresh-droppers.mjs   # recorders: recompute 12-mo change only
node scripts/refresh-manual.mjs     # manual wells: re-scrape CCGCD map (needs Chrome)
# or the full weekly job (both refreshes + deploy + local commit):
bash scripts/weekly-update.sh
```

## Manage the schedule
```sh
launchctl load  -w ~/Library/LaunchAgents/com.texaswaterwatchers.weekly.plist   # enable
launchctl unload -w ~/Library/LaunchAgents/com.texaswaterwatchers.weekly.plist  # disable
launchctl list | grep texaswaterwatchers                                        # check it's loaded
```
Logs: `scripts/weekly-update.log` (and `launchd.out.log` / `launchd.err.log`).
Note: the Mac must be awake around the scheduled time; if it was asleep, launchd runs the job at the next opportunity.
