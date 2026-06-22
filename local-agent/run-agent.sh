#!/usr/bin/env bash
# Self-deploying launcher for the stats agent — this is what launchd fires.
#
# Why a wrapper instead of pointing launchd straight at refresh.sh:
#   1. No drift. refresh.sh is edited in the project-assets repo, but the agent
#      historically ran a hand-copied snapshot at ~/.claude-stats/refresh.sh.
#      A manual `cp` was the only deploy step, so the copy silently went stale
#      (it lacked the Codex token source for two days). This wrapper re-syncs the
#      script from the repo on every run, so a merged change is live next tick.
#   2. Stable execution. refresh.sh runs `git pull --rebase` on its own repo near
#      the end. If launchd executed the repo file directly, that pull could mutate
#      the script file mid-read. We copy to a stable path and exec the copy, so the
#      running file is never the file being pulled.
#
# Deployed to ~/.claude-stats/run-agent.sh; see README.md for install steps.

set -uo pipefail

REPO="$HOME/code/project-assets"
DEPLOY="$HOME/.claude-stats/refresh.sh"

mkdir -p "$HOME/.claude-stats"

# Pull the latest agent script (non-fatal: offline / transient git errors just run
# the last-synced copy). refresh.sh does its own commit/pull/push later in the run.
git -C "$REPO" pull --rebase --autostash --quiet 2>/dev/null || true

# Deploy the current repo script + the Antigravity parser it calls to stable
# paths, then run the script copy. Keeping the parser in sync here prevents the
# same drift the wrapper exists to fix.
if [[ -f "$REPO/local-agent/refresh.sh" ]]; then
  install -m 0755 "$REPO/local-agent/refresh.sh" "$DEPLOY"
fi
if [[ -f "$REPO/local-agent/antigravity-tokens.py" ]]; then
  install -m 0644 "$REPO/local-agent/antigravity-tokens.py" "$HOME/.claude-stats/antigravity-tokens.py"
fi

exec /bin/bash "$DEPLOY"
