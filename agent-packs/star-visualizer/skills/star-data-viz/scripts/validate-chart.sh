#!/usr/bin/env bash
# Validates star-data-widget output for CI/local smoke tests.
set -euo pipefail

ROOT="${1:-$(pwd)}"
cd "$ROOT"

WIDGET="$ROOT/.agent-hippo/analytics/views/star-visualizer/scripts/star-data-widget.js"
CHART="$ROOT/.agent-hippo/analytics/views/star-visualizer/charts/star-data-widget.html"
VIEWS="$ROOT/.agent-hippo/analytics/panel/views.yaml"

if [[ ! -f "$WIDGET" ]]; then
  echo "Missing widget: $WIDGET" >&2
  exit 1
fi

AGENTIDE_WORKSPACE_ROOT="$ROOT" AGENTIDE_CHART_DIR="$(dirname "$CHART")" node "$WIDGET"

if [[ ! -f "$CHART" ]]; then
  echo "Chart not generated: $CHART" >&2
  exit 1
fi

grep -q 'Star Visualizer' "$CHART" || { echo "Chart HTML missing title" >&2; exit 1; }

node -e "
const fs = require('fs');
const html = fs.readFileSync(process.argv[1], 'utf8');
const m = html.match(/const data=({[\\s\\S]*?});\\nconst esc/);
if (!m) { console.error('No embedded chart data'); process.exit(1); }
const data = JSON.parse(m[1]);
if (!Array.isArray(data.datasets)) { console.error('datasets missing'); process.exit(1); }
console.log('datasets:', data.datasets.length);
for (const d of data.datasets) {
  if (!d.rows?.length || !d.numericColumns?.length) {
    console.error('Invalid dataset', d.rel);
    process.exit(1);
  }
}
" "$CHART"

if [[ -f "$VIEWS" ]]; then
  grep -q 'activeViewId: star-visualizer' "$VIEWS" || { echo "views.yaml missing activeViewId" >&2; exit 1; }
  grep -q 'star-data-widget.js' "$VIEWS" || { echo "views.yaml missing widget script" >&2; exit 1; }
fi

echo "validate-chart: OK ($CHART)"
