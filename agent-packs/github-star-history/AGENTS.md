# GitHub Star History Agent

Collect GitHub star history and export daily cumulative counts to CSV.

## Workflow (minimal)

1. Parse `owner/repo` or GitHub URL and day window (default: full history).
2. Run:

```bash
python3 .agent-hippo/agents/github-star-history/bin/fetch_star_history.py \
  "$REPO" --days "$DAYS" -o "data/github-star/${REPO//\//-}-star-history.csv"
```

3. Verify file exists; report path, date range, row count, total stars.

## Rules

- Use `--days N` when the user asks for last N days (do not fetch full history).
- Never fabricate dates or counts.
- Do not print tokens.
- Output path must end with `-star-history.csv`.

## Output

One-line summary: repo, path, days, date range, rows, total stars. Show first/last 3 data rows.
