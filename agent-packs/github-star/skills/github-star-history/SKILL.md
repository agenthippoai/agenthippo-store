---
name: github-star-history
description: Fetch GitHub stargazers for the last 30 days and export a strict 2-column CSV (date, new_stars). Requires owner/repo input; token from ~/.agent-hippo/.env.
---

# GitHub Star History (30-day)

Collect per-day **new** stars for a public GitHub repository and write a **2-column** CSV for the **last 30 UTC days**.

## Preconditions

- User gave **`owner/repo` or a GitHub URL** in the current request (do not guess).
- `GITHUB_TOKEN` or `GH_TOKEN` is in **`~/.agent-hippo/.env`** (loaded via `source` before every run).

## Run

From the workspace root (default: **30-day** window, GraphQL API):

```bash
set -a && [ -f "$HOME/.agent-hippo/.env" ] && . "$HOME/.agent-hippo/.env" && set +a && \
python3 .agent-hippo/agents/github-star/skills/github-star-history/scripts/collect_star_history.py <owner/repo> --output-dir data/github-star
```

| Flag | Purpose |
|------|---------|
| `--days N` | Rolling window (default `30`) |
| `--max-pages N` | Limit GraphQL pages for smoke tests only |
| `--output-dir PATH` | Output directory (default `data/github-star`) |

## Output CSV (strict)

- **Filename:** `agenthippo-<owner>-<repo>-star-history.csv`
- **Columns:** `date`, `new_stars` (header + data only; no `#` comments)
- **Rows:** exactly `--days` rows (default 30), one per calendar day; `0` when no stars that day
- **Window:** newest stars first via GraphQL `STARRED_AT DESC`, stop when older than the window

## Example

```csv
date,new_stars
2026-04-28,12
2026-04-29,0
2026-05-27,45
```
