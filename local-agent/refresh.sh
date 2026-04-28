#!/usr/bin/env bash
# Daily refresh of Anthropic Claude Code token totals from Cursatory + habitat,
# pushed as anthropic-usage.json into the project-assets repo for the
# centralized stats collector to consume.
#
# Triggered by ~/Library/LaunchAgents/com.jasonvaughan.claude-stats.plist
# (daily at 05:30 local). May also be run manually for testing.

set -euo pipefail

PROJECT_ASSETS="$HOME/Documents/Projects/project-assets"
USAGE_FILE="$PROJECT_ASSETS/anthropic-usage.json"
GEMINI_USAGE_FILE="$PROJECT_ASSETS/gemini-usage.json"
GEMINI_TELEMETRY_LOG="$HOME/.gemini/telemetry.log"
LOG_DIR="$HOME/.claude-stats"
LOG_FILE="$LOG_DIR/last-run.log"

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

GEMINI_TOTAL=0
if [[ -f "$GEMINI_TELEMETRY_LOG" ]]; then
  echo "[gemini] parsing $GEMINI_TELEMETRY_LOG..."
  GEMINI_TOTAL=$(python3 -c "
import sys, re, json
total = 0
with open('$GEMINI_TELEMETRY_LOG', 'r', errors='replace') as f:
    for line in f:
        # Match input_token_count / output_token_count / cached_content_token_count attributes
        for m in re.finditer(r'(input_token_count|output_token_count|cached_content_token_count|tool_token_count)[\":=\s]+([0-9]+)', line):
            try:
                total += int(m.group(2))
            except ValueError:
                pass
print(total)
" 2>/dev/null)
  GEMINI_TOTAL=${GEMINI_TOTAL:-0}
  echo "[gemini] total: $GEMINI_TOTAL"
else
  echo "[gemini] no telemetry log yet at $GEMINI_TELEMETRY_LOG (will populate after next CLI session)"
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

cd "$PROJECT_ASSETS"
git pull --rebase --quiet
git add anthropic-usage.json gemini-usage.json
if git diff --cached --quiet; then
  echo "[git] no changes to commit"
else
  git commit -m "chore(stats): refresh AI usage agents ($NOW)"
  git push --quiet
  echo "[git] pushed"
fi

echo "=== done ==="
