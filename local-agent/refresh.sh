#!/usr/bin/env bash
# Daily refresh of Anthropic Claude Code token totals from Cursatory + habitat,
# pushed as anthropic-usage.json into the project-assets repo for the
# centralized stats collector to consume.
#
# Triggered by ~/Library/LaunchAgents/com.jasonvaughan.claude-stats.plist
# (daily at 05:30 local). May also be run manually for testing.
#
# NOTE: the clone lives in ~/code (NOT ~/Documents). macOS TCC blocks launchd
# agents from writing into ~/Documents/Desktop/Downloads without Full Disk
# Access, which silently froze this file at 2026-04-28 ("Operation not
# permitted" on the write). Keep this path outside the TCC-protected folders.

set -euo pipefail

PROJECT_ASSETS="$HOME/code/project-assets"
USAGE_FILE="$PROJECT_ASSETS/anthropic-usage.json"
GEMINI_USAGE_FILE="$PROJECT_ASSETS/gemini-usage.json"
GEMINI_TELEMETRY_LOG="$HOME/.gemini/telemetry.log"
LOG_DIR="$HOME/.claude-stats"
LOG_FILE="$LOG_DIR/last-run.log"
# Antigravity (agy) — successor to the sunsetted Gemini CLI. Usage is read from
# agy's local SQLite conversation DBs (one global store, launcher-independent, so
# terminal/cron/TangleClaw sessions all count) via a hardened protobuf parser.
ANTIGRAVITY_USAGE_FILE="$PROJECT_ASSETS/antigravity-usage.json"
ANTIGRAVITY_CONV_DIR="$HOME/.gemini/antigravity-cli/conversations"
ANTIGRAVITY_PARSER="$LOG_DIR/antigravity-tokens.py"

# Make sure the npm-global bin is on PATH (where ccusage is installed locally).
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$LOG_DIR"
exec > >(tee "$LOG_FILE") 2>&1

echo "=== Claude Code stats refresh: $(date -u +%FT%TZ) ==="

# Helper: parse ccusage JSON output (strips ANSI, sums totalTokens across months)
parse_total() {
  python3 -c "
import sys, json, re
raw = sys.stdin.read()
clean = re.sub(r'\x1b\[[0-9;]*m', '', raw)
start = clean.find('{')
end = clean.rfind('}')
if start == -1:
    print(0); sys.exit(0)
try:
    data = json.loads(clean[start:end+1])
    print(sum(m.get('totalTokens', 0) for m in data.get('monthly', [])))
except Exception:
    print(0)
"
}

# Cursatory (local)
echo "[cursatory] running ccusage..."
CURSATORY_TOTAL=$(ccusage monthly --json 2>/dev/null | parse_total)
echo "[cursatory] total: $CURSATORY_TOTAL"

# habitat (via SSH; uses npx since ccusage isn't installed globally there)
echo "[habitat] running ccusage via SSH..."
HABITAT_TOTAL=$(ssh -o ConnectTimeout=15 -o BatchMode=yes habitat \
  'export PATH="/usr/local/bin:$PATH"; npx -y ccusage@latest monthly --json' 2>/dev/null \
  | parse_total) || HABITAT_TOTAL=0
echo "[habitat] total: $HABITAT_TOTAL"

TOTAL=$((CURSATORY_TOTAL + HABITAT_TOTAL))
echo "[combined] total: $TOTAL"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "ERROR: combined total is 0; refusing to write zero-value usage file."
  exit 1
fi

# Regression guard: if either machine was unreachable, the partial total
# would silently regress the live number. Compare to last successful run.
PREV_TOTAL=0
if [[ -f "$USAGE_FILE" ]]; then
  PREV_TOTAL=$(python3 -c "import json,sys; print(json.load(open('$USAGE_FILE')).get('total', 0))" 2>/dev/null || echo 0)
fi
if [[ "$PREV_TOTAL" -gt 0 ]]; then
  THRESHOLD=$((PREV_TOTAL * 95 / 100))
  if [[ "$TOTAL" -lt "$THRESHOLD" ]]; then
    echo "ERROR: new total $TOTAL is >5% below previous $PREV_TOTAL — likely a machine was unreachable."
    echo "  Refusing to overwrite. Will retry on the next scheduled run."
    exit 2
  fi
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$USAGE_FILE" <<EOF
{
  "total": $TOTAL,
  "byMachine": {
    "cursatory": $CURSATORY_TOTAL,
    "habitat": $HABITAT_TOTAL
  },
  "fetchedAt": "$NOW"
}
EOF

echo "[file] wrote $USAGE_FILE"

# === Gemini CLI telemetry → gemini-usage.json ===
# Telemetry is enabled in ~/.gemini/settings.json with target=local. Each
# Gemini CLI session appends OTLP-like JSON events to telemetry.log; we sum
# input + output + cached token counts across all gemini_cli.api_response
# events. If the log doesn't exist yet, write a zero-value file (Medusa is
# the only project using Gemini CLI today; log populates on next session).

# Incremental parse: telemetry.log grows without bound (it reached 70GB once a
# full-file scan was reattempted), so we never re-read history. We track a byte
# offset in $GEMINI_OFFSET_FILE and only sum tokens from NEW bytes each run,
# carrying the cumulative total forward in $GEMINI_USAGE_FILE. First run (no
# offset file) baselines at EOF — historical pre-fix telemetry is not
# retro-counted (it was never in the headline; the manifest used a manual value).
GEMINI_OFFSET_FILE="$LOG_DIR/gemini-offset"
GEMINI_TOTAL=0
if [[ -f "$GEMINI_TELEMETRY_LOG" ]]; then
  echo "[gemini] incremental parse of $GEMINI_TELEMETRY_LOG..."
  GEMINI_TOTAL=$(python3 -c "
import os, re, json
log = '$GEMINI_TELEMETRY_LOG'
offset_file = '$GEMINI_OFFSET_FILE'
usage_file = '$GEMINI_USAGE_FILE'

prev_total = 0
try:
    with open(usage_file) as f:
        prev_total = int(json.load(f).get('total', 0))
except Exception:
    prev_total = 0

size = os.path.getsize(log)
try:
    with open(offset_file) as f:
        start = int(f.read().strip())
except Exception:
    start = None

if start is None:
    start = size          # first run: skip history, count only new telemetry
elif start > size:
    start = 0             # log rotated/truncated: re-scan the smaller file

delta = 0
pat = re.compile(r'(input_token_count|output_token_count|cached_content_token_count|tool_token_count)[\":=\s]+([0-9]+)')
with open(log, 'r', errors='replace') as f:
    f.seek(start)
    f.readline()          # discard a possibly-partial line at the seek boundary
    for line in f:
        for m in pat.finditer(line):
            try:
                delta += int(m.group(2))
            except ValueError:
                pass

with open(offset_file, 'w') as f:
    f.write(str(size))
print(prev_total + delta)
" 2>/dev/null)
  GEMINI_TOTAL=${GEMINI_TOTAL:-0}
  echo "[gemini] total: $GEMINI_TOTAL (cumulative, incremental)"
else
  echo "[gemini] no telemetry log yet at $GEMINI_TELEMETRY_LOG (will populate after next CLI session)"
fi

# Rolling size cap: keep the newest GEMINI_LOG_CAP_GB, prune oldest. Runs AFTER
# the incremental parse (which counted through EOF and saved the offset), so
# dropping already-counted old bytes loses nothing; we reset the offset to the
# post-trim EOF so the next run counts only new appends. Gemini CLI itself has
# no rotation (settings.json is just enabled/target/outfile) and re-logs its full
# ~39KB system prompt on every event, so without this the log grows unbounded.
# Hysteresis: prune only ABOVE the high watermark, and trim down to the low one —
# so a few MB over cap doesn't rewrite 10GB every run (that thrash blocked the rest
# of the script). Gemini CLI is sunsetted now, so this log is near-static; this is
# just a cheap safety backstop, not a daily chore.
GEMINI_LOG_HIGH_GB=12
GEMINI_LOG_LOW_GB=8
if [[ -f "$GEMINI_TELEMETRY_LOG" ]]; then
  HIGH_BYTES=$(( GEMINI_LOG_HIGH_GB * 1024 * 1024 * 1024 ))
  LOW_BYTES=$(( GEMINI_LOG_LOW_GB * 1024 * 1024 * 1024 ))
  CUR_BYTES=$(stat -f%z "$GEMINI_TELEMETRY_LOG" 2>/dev/null || echo 0)
  if (( CUR_BYTES > HIGH_BYTES )); then
    echo "[gemini] log $(( CUR_BYTES / 1073741824 ))GB > ${GEMINI_LOG_HIGH_GB}GB — pruning oldest down to ${GEMINI_LOG_LOW_GB}GB..."
    TRIM_TMP="${GEMINI_TELEMETRY_LOG}.trim.$$"
    if tail -c "$LOW_BYTES" "$GEMINI_TELEMETRY_LOG" > "$TRIM_TMP" 2>/dev/null && mv "$TRIM_TMP" "$GEMINI_TELEMETRY_LOG"; then
      stat -f%z "$GEMINI_TELEMETRY_LOG" > "$GEMINI_OFFSET_FILE"
      echo "[gemini] trimmed to $(( $(stat -f%z "$GEMINI_TELEMETRY_LOG") / 1073741824 ))GB; offset reset to new EOF"
    else
      rm -f "$TRIM_TMP"
      echo "[gemini] WARN: trim failed; log left intact"
    fi
  fi
fi

cat > "$GEMINI_USAGE_FILE" <<EOF
{
  "total": $GEMINI_TOTAL,
  "source": "gemini-cli local telemetry",
  "telemetryLog": "$GEMINI_TELEMETRY_LOG",
  "fetchedAt": "$NOW"
}
EOF
echo "[file] wrote $GEMINI_USAGE_FILE"

# === Antigravity (agy) usage → antigravity-usage.json ===
# Cumulative lifetime tokens summed from agy's local SQLite conversation DBs,
# cached INCLUDED. Carry-forward guard: if the recomputed total drops below the
# last recorded value (e.g. agy prunes old conversation DBs), keep the previous
# higher value so the lifetime stat never regresses.
if [[ -f "$ANTIGRAVITY_PARSER" ]]; then
  echo "[antigravity] parsing $ANTIGRAVITY_CONV_DIR ..."
  AGY_JSON=$(python3 "$ANTIGRAVITY_PARSER" "$ANTIGRAVITY_CONV_DIR" 2>/dev/null || true)
  if [[ -n "$AGY_JSON" ]]; then
    if python3 - "$ANTIGRAVITY_USAGE_FILE" "$NOW" "$AGY_JSON" <<'PYEOF'
import json, sys
usage_file, now, agy_json = sys.argv[1], sys.argv[2], sys.argv[3]
new = json.loads(agy_json)
prev_total = 0
try:
    with open(usage_file) as f:
        prev_total = int(json.load(f).get('total', 0))
except Exception:
    prev_total = 0
total = int(new.get('total', 0))
if total < prev_total:
    print(f"[antigravity] WARN: recomputed {total:,} < previous {prev_total:,} (DBs pruned?); keeping previous", file=sys.stderr)
    sys.exit(0)
out = {
    "total": total,
    "prompt": int(new.get('prompt', 0)),
    "output": int(new.get('output', 0)),
    "cached": int(new.get('cached', 0)),
    "tool": int(new.get('tool', 0)),
    "includesCached": True,
    "source": "antigravity-cli local SQLite gen_metadata",
    "dbs": int(new.get('dbs', 0)),
    "rows": int(new.get('rows', 0)),
    "fetchedAt": now,
}
with open(usage_file, 'w') as f:
    json.dump(out, f, indent=2)
print(f"[antigravity] total {total:,} (prompt {out['prompt']:,} + output {out['output']:,} + cached {out['cached']:,} + tool {out['tool']:,})")
PYEOF
    then :; else echo "[antigravity] WARN: writer failed — leaving previous antigravity-usage.json"; fi
  else
    echo "[antigravity] parser returned nothing — skipping (no DBs yet?)"
  fi
else
  echo "[antigravity] parser not found at $ANTIGRAVITY_PARSER — skipping"
fi

cd "$PROJECT_ASSETS"
# Stage + commit BEFORE pulling: the script writes the usage files first, so a
# pull --rebase against a dirty tree errors ("unstaged changes"). Commit first,
# then rebase our commit onto the latest remote (the cloud collector pushes
# several times a day), then push. --autostash covers any stray local edits.
git add anthropic-usage.json gemini-usage.json
if [[ -f antigravity-usage.json ]]; then git add antigravity-usage.json; fi
if git diff --cached --quiet; then
  echo "[git] no changes to commit"
  git pull --rebase --autostash --quiet || true
else
  git commit -m "chore(stats): refresh AI usage agents ($NOW)"
  git pull --rebase --autostash --quiet
  git push --quiet
  echo "[git] pushed"
fi

echo "=== done ==="
