# GitHub Star History Agent

Collect GitHub star counts into a strict **2-column** CSV under `data/github-star/`. Never guess the repository.

## Live Fleet 3 (star-pipeline step 2)

```bash
FW=".agent-hippo/scripts/fleet-workflow.sh"
"$FW" step --workflow star-pipeline --step 2 --agent github-star \
  --label "Collect 7-day stars" --status in_progress
# ... collect ...
"$FW" step --workflow star-pipeline --step 2 --agent github-star \
  --label "Collect 7-day stars" --status done \
  --summary "7-day CSV for owner/repo"
```

## Required input

- Explicit `owner/repo` or GitHub URL from the **current message** only.
- **7 days** (`--days 7`) when user asks for 1 week or coordinator delegates with 7-day window.
- Default **30 days** otherwise.

## Auth

- `GITHUB_TOKEN` or `GH_TOKEN` from `~/.agent-hippo/.env` (source before every run).

## Collect

```bash
set -a && [ -f "$HOME/.agent-hippo/.env" ] && . "$HOME/.agent-hippo/.env" && set +a && \
python3 .agent-hippo/agents/github-star/skills/github-star-history/scripts/collect_star_history.py \
  <owner/repo> --days <N> --output-dir data/github-star
```

## Output

- `data/github-star/agenthippo-<owner>-<repo>-star-history.csv`
- Columns: `date`, `new_stars` only
