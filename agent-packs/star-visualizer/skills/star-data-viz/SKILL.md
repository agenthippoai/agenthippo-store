---
name: star-data-viz
description: Build interactive Spotlight HTML charts from workspace data/ CSV files. Use when visualizing star history, MAU/revenue, or other tabular CSV data in Spotlight.
---

# Star Data Visualization

Generate an interactive HTML chart in Spotlight from CSV files under `data/`.

## When to use

- User wants to visualize data from the `data/` folder
- Star history CSVs exist (e.g. `data/github-star/*-star-history.csv`)
- MAU/revenue or other CSV metrics should appear in Spotlight

## Run widget

From workspace root:

```bash
AGENTIDE_WORKSPACE_ROOT="$(pwd)" \
AGENTIDE_CHART_DIR="$(pwd)/.agent-hippo/analytics/views/star-visualizer/charts" \
node .agent-hippo/analytics/views/star-visualizer/scripts/star-data-widget.js
```

## Spotlight setup

1. View config: `.agent-hippo/analytics/views/star-visualizer/view.yaml`
2. Panel: `.agent-hippo/analytics/panel/views.yaml` → `activeViewId: star-visualizer`
3. Output: `.agent-hippo/analytics/views/star-visualizer/charts/star-data-widget.html`

## Supported CSV formats

| Pattern | Columns | Notes |
|---------|---------|-------|
| GitHub star history | `date`, `new_stars`, `cumulative_stars` | `# repo=...` metadata lines optional |
| MAU / revenue | `month`, `mau`, `revenue_usd` | Any numeric columns are plottable |
| Generic | header row + numeric columns | First date-like or string column used as X labels |

## Verify

```bash
.agent-hippo/agents/star-visualizer/skills/star-data-viz/scripts/validate-chart.sh
```

Or manually:

```bash
test -f .agent-hippo/analytics/views/star-visualizer/charts/star-data-widget.html && echo OK
```
