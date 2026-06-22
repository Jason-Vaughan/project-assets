# Local agent — disaster recovery + redeployment

Disaster-recovery copies of the Mac-side wiring that powers the daily Anthropic + Gemini token refresh feeding the centralized stats collector.

This dir is the canonical source for what should be running on the user's primary Mac (Cursatory). The deployed copies live at `~/.claude-stats/` and `~/Library/LaunchAgents/`.

## What's in here

| File | Deployed location | Purpose |
|---|---|---|
| `run-agent.sh` | `~/.claude-stats/run-agent.sh` (chmod +x) | **What launchd fires.** Pulls the latest `refresh.sh` from the repo, deploys it to `~/.claude-stats/refresh.sh`, and execs it. Self-deploying: a merged `refresh.sh` change is live on the next tick — no manual `cp`. |
| `refresh.sh` | `~/.claude-stats/refresh.sh` (auto-synced by `run-agent.sh`) | The work script. Runs ccusage (Claude Code) + `ccusage codex` on Cursatory + via SSH on habitat, parses Gemini telemetry + Antigravity SQLite, writes the `*-usage.json` files to project-assets, commits + pushes. |
| `com.jasonvaughan.claude-stats.plist` | `~/Library/LaunchAgents/com.jasonvaughan.claude-stats.plist` | macOS LaunchAgent. Fires `run-agent.sh` 4x/day (05:30, 11:30, 17:30, 23:30 local). |
| `antigravity-tokens.py` | `~/.claude-stats/antigravity-tokens.py` | Protobuf/SQLite parser for Antigravity (agy) token totals, invoked by `refresh.sh`. |
| `gemini-telemetry-snippet.json` | Merge into `~/.gemini/settings.json` | Enables Gemini CLI to write a telemetry log to `~/.gemini/telemetry.log` so `refresh.sh` can parse token totals. |

## Redeploying on a fresh Mac

Assumes the user owns the Mac and has GitHub auth configured (gh CLI logged in, or an active git credential helper).

```bash
# 1. Install ccusage globally
npm install -g ccusage

# 2. Verify SSH alias to habitat works (an entry in ~/.ssh/config pointing
#    to 192.168.20.10 with the right key). Should already be set up.
ssh habitat 'whoami'   # should return: habitat-admin

# 3. Drop the self-deploying launcher into place (it syncs refresh.sh itself).
#    Assumes the project-assets clone lives at ~/code/project-assets.
mkdir -p ~/.claude-stats
cp local-agent/run-agent.sh ~/.claude-stats/run-agent.sh
cp local-agent/antigravity-tokens.py ~/.claude-stats/antigravity-tokens.py
chmod +x ~/.claude-stats/run-agent.sh
# refresh.sh is auto-deployed by run-agent.sh on first run; no manual copy needed.

# 4. Drop the LaunchAgent into place
#    Edit hardcoded /Users/jasonvaughan paths if the user differs.
cp local-agent/com.jasonvaughan.claude-stats.plist \
   ~/Library/LaunchAgents/com.jasonvaughan.claude-stats.plist
launchctl load ~/Library/LaunchAgents/com.jasonvaughan.claude-stats.plist

# 5. Enable Gemini CLI telemetry
#    Merge the snippet into ~/.gemini/settings.json (preserve existing keys).
#    Easiest with jq:
jq -s '.[0] * .[1]' ~/.gemini/settings.json local-agent/gemini-telemetry-snippet.json \
   > /tmp/settings.merged.json && mv /tmp/settings.merged.json ~/.gemini/settings.json

# 6. Smoke test
~/.claude-stats/run-agent.sh
# Should sync + print Cursatory + habitat ccusage totals (Claude Code + Codex),
# write the *-usage.json files under ~/code/project-assets, commit, push.
```

## Schedule

- **05:30 / 11:30 / 17:30 / 23:30 local time (4x/day)** — launchd fires `run-agent.sh`
- **Hourly (`0 * * * *`)** — GitHub workflow `collect-stats.yml` runs in project-assets, picks up the latest agent files

The collector is hourly but the agent files only change when the local agent runs, so token freshness is bounded by the local cadence: at 4x/day, the live portfolio's token stats are at most ~6 hours stale (was ~24h at 1x/day).

## Logs

- `~/.claude-stats/last-run.log` — most recent refresh.sh run (full output)
- `~/.claude-stats/launchd.log` / `.err.log` — launchd's capture of script stdout/stderr

If the agent stops working, those are the first place to look.

## Path assumptions baked into these files

If you move the user account or rename `Documents/Projects/`, you'll need to update:

- `refresh.sh` / `run-agent.sh` — `PROJECT_ASSETS` / `REPO` = `$HOME/code/project-assets` (moved out of `~/Documents` to escape macOS TCC restrictions on launchd writes)
- `com.jasonvaughan.claude-stats.plist` — `ProgramArguments`, `StandardOutPath`, `StandardErrorPath`, `EnvironmentVariables.HOME` and `EnvironmentVariables.PATH`
- `gemini-telemetry-snippet.json` — `outfile` path

The script otherwise expects the same Mac-standard layout the user is on today.
