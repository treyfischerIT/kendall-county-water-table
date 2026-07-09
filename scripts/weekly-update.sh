#!/bin/bash
# Weekly job: recompute the 12-month "dramatic droppers", deploy, and commit locally.
# Scheduled by ~/Library/LaunchAgents/com.texaswaterwatchers.weekly.plist (Mondays 7am).
# Does NOT git push (that stays manual, per project preference).
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
REPO="/Users/trey/kendall-county-water-table"
LOG="$REPO/scripts/weekly-update.log"
cd "$REPO" || exit 1

echo "===== $(date) =====" >> "$LOG"
# 23 automatic recorders (TWDB feeds) — rewrites CHG12_RECORDER. A failure here is fatal.
node scripts/refresh-droppers.mjs >> "$LOG" 2>&1 || { echo "refresh-droppers FAILED" >> "$LOG"; exit 1; }
# 26 hand-measured wells (CCGCD map scrape) — rewrites CHG12_MANUAL + manual-wells.json.
# Non-fatal: if the scrape hiccups it keeps last-good manual data and we still deploy the recorders.
node scripts/refresh-manual.mjs >> "$LOG" 2>&1 || echo "refresh-manual skipped (kept previous manual data)" >> "$LOG"
npx wrangler deploy >> "$LOG" 2>&1 || { echo "deploy FAILED" >> "$LOG"; exit 1; }
git add public/index.html public/manual-wells.json wells-catalog.json >> "$LOG" 2>&1
git commit -m "Weekly groundwater refresh ($(date -u +%Y-%m-%d))" >> "$LOG" 2>&1
echo "done (not pushed — run 'git push' when you want to sync GitHub)" >> "$LOG"
