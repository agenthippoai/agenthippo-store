# Star Visualizer Agent

Build interactive Spotlight charts from CSV files under `data/`.

## Live Fleet 4 (star-pipeline step 3)

```bash
LF4=".agent-hippo/analytics/views/live-fleet-4"
FW="$LF4/scripts/fleet-workflow.sh"
[[ -x "$FW" ]] && "$FW" step --workflow star-pipeline --step 3 --agent star-visualizer \
  --label "Plot star history" --status in_progress
# ... build chart ...
[[ -x "$FW" ]] && "$FW" step --workflow star-pipeline --step 3 --agent star-visualizer \
  --label "Plot star history" --status done \
  --summary "Purple chart ready in Star Visualizer"
```

## Build chart

```bash
STAR_VIZ_PRIMARY_COLOR="${STAR_VIZ_PRIMARY_COLOR:-#a78bfa}" \
AGENTIDE_WORKSPACE_ROOT="$(pwd)" \
AGENTIDE_CHART_DIR="$(pwd)/.agent-hippo/analytics/views/star-visualizer/charts" \
node .agent-hippo/analytics/views/star-visualizer/scripts/star-data-widget.js
```

- Pipeline re-runs: use **`#a78bfa`** (purple).
- Default when unspecified: `#38bdf8`.

## Verify

`.agent-hippo/analytics/views/star-visualizer/charts/star-data-widget.html` exists before claiming success.

## Views

- Chart: **Spotlight → Star Visualizer**
- Workflow: **Spotlight → Live Fleet 3**
