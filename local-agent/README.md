# Local agent — disaster recovery + redeployment

Disaster-recovery copies of the Mac-side wiring that powers the daily Anthropic + Gemini token refresh feeding the centralized stats collector.

This dir is the canonical source for what should be running on the user's primary Mac (Cursatory). The deployed copies live at `~/.claude-stats/` and `~/Library/LaunchAgents/`.

## What's in here

| File | Deployed location | Purpose |
|---|---|---|
| `refresh.sh` | `~/.claude-stats/refresh.sh` (chmod +x) | Daily script. Runs ccusage on Cursatory + via SSH on habitat, parses Gemini telemetry log, writes `anthropic-usage.json` + `gemini-usage.json` to project-assets, commits + pushes. |
| `com.jasonvaughan.claude-stats.plist` | `~/Library/LaunchAgents/com.jasonvaughan.claude-stats.plist` | macOS LaunchAgent. Fires `refresh.sh` at 05:30 local daily. |
| `gemini-telemetry-snippet.json` | Merge into `~/.gemini/settings.json` | Enables Gemini CLI to write a telemetry log to `~/.gemini/telemetry.log` so `refresh.sh` can parse token totals. |

## Redeploying on a fresh Mac

Assumes the user owns the Mac and has GitHub auth configured (gh CLI logged in, or an active git credential helper).

```bash
# 1. Install ccusage globally
npm install -g ccusage

# 2. Verify SSH alias to habitat works (an entry in ~/.ssh/config pointing
#    to 192.168.20.10 with the right key). Should already be set up.
ssh habitat 'whoami'   # should return: habitat-admin

# 3. Drop the agent script into place
mkdir -p ~/.claude-stats
cp local-agent/refresh.sh ~/.claude-stats/refresh.sh
chmod +x ~/.claude-stats/refresh.sh

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
~/.claude-stats/refresh.sh
# Should print Cursatory + habitat ccusage totals, write
# anthropic-usage.json + gemini-usage.json under
# ~/Documents/Projects/project-assets, commit, push.
```

## Schedule

- **05:30 local time daily** — launchd fires `refresh.sh`
- **06:00 UTC daily** — GitHub workflow `collect-stats.yml` runs in project-assets, picks up the latest agent files

The local refresh runs *before* the GitHub cron, so each day's Anthropic/Gemini values are at most ~24 hours stale on the live portfolio — same freshness as the GitHub-derived stats.

## Logs

- `~/.claude-stats/last-run.log` — most recent refresh.sh run (full output)
- `~/.claude-stats/launchd.log` / `.err.log` — launchd's capture of script stdout/stderr

If the agent stops working, those are the first place to look.

## Path assumptions baked into these files

If you move the user account or rename `Documents/Projects/`, you'll need to update:

- `refresh.sh` — `PROJECT_ASSETS="$HOME/Documents/Projects/project-assets"`
- `com.jasonvaughan.claude-stats.plist` — `ProgramArguments`, `StandardOutPath`, `StandardErrorPath`, `EnvironmentVariables.HOME` and `EnvironmentVariables.PATH`
- `gemini-telemetry-snippet.json` — `outfile` path

The script otherwise expects the same Mac-standard layout the user is on today.
