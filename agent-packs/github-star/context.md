# GitHub Star Pack Context

## Contract

- **Input:** explicit `owner/repo` or GitHub URL from the user (never inferred).
- **Auth:** `GITHUB_TOKEN` or `GH_TOKEN` from `~/.agent-hippo/.env` (always `source` before runs).
- **Window:** last 30 UTC days (default `--days 30`).
- **Output:** `data/github-star/agenthippo-<owner>-<repo>-star-history.csv`
- **Format:** header `date,new_stars` then exactly 30 daily rows (UTC).

## Workspace

- **Root:** `/Users/tom/dev/agenthippo-vscode`
