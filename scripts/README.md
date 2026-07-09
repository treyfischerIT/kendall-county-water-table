# Weekly "dramatic droppers" refresh

The map colors each of the 23 wells by its **12-month change in depth-to-water**:

| Color | Meaning |
|---|---|
| 🔴 Red (larger dot) | Dropped 15+ ft in 12 months (dramatic) |
| 🟠 Amber | Dropped 5–15 ft |
| 🔵 Blue | Roughly stable (±5 ft) |
| 🟢 Green | Recovered 5+ ft |
| ⚪ Gray | Not enough record yet |

Those values live in `public/index.html` as `const CHG12 = {...}` with a snapshot date
`const CHG12_ASOF`. They're also cached in `wells-catalog.json` (`change12moFt` per well +
`chg12UpdatedAt`), so nothing needs to re-download the big TWDB feeds for routine use.

## How it updates (weekly, automatic)

`scripts/refresh-droppers.mjs` refetches each well's feed, recomputes the 12-month change,
and rewrites both `CHG12`/`CHG12_ASOF` in `index.html` and the catalog. On a single-well
fetch failure it keeps that well's previous value, so a hiccup never blanks the map.

`scripts/weekly-update.sh` runs that script, then `npx wrangler deploy`, then a **local**
git commit (it does not `git push` — that stays manual).

A launchd agent runs it **every Monday at 7:00 AM**:
`~/Library/LaunchAgents/com.texaswaterwatchers.weekly.plist`

## Manual run
```sh
cd ~/kendall-county-water-table
node scripts/refresh-droppers.mjs   # recompute values only
# or the full weekly job (recompute + deploy + local commit):
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
