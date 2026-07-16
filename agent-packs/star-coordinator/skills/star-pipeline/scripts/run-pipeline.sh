#!/usr/bin/env bash
# Run github-star collection then star-visualizer widget for owner/repo.
set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  echo "Usage: run-pipeline.sh <owner/repo>" >&2
  exit 1
fi

# scripts → star-pipeline → skills → star-coordinator → agents → .agent-hippo → workspace (6 levels)
WORKSPACE="$(cd "$(dirname "$0")/../../../../../.." && pwd)"
cd "$WORKSPACE"

CSV="data/github-star/$(echo "$REPO" | tr '/' '-')-star-history.csv"
CHART=".agent-hippo/analytics/views/star-visualizer/charts/star-data-widget.html"

collect() {
  if command -v agenthippo >/dev/null 2>&1; then
    agenthippo ask \
      "Collect star history for ${REPO}. Write CSV to data/github-star/ and report the CSV path, date range, row count, and limitations." \
      --agent github-star \
      --workspace "$WORKSPACE"
    return
  fi
  python3 .agent-hippo/agents/github-star/skills/github-star-history/scripts/collect_star_history.py "$REPO" --output-dir data/github-star
}

visualize() {
  if command -v agenthippo >/dev/null 2>&1; then
    agenthippo ask \
      "Build the Spotlight star-data widget from CSV files under data/, especially data/github-star/*-star-history.csv. Set activeViewId to star-visualizer and report the chart HTML path." \
      --agent star-visualizer \
      --workspace "$WORKSPACE"
    return
  fi
  AGENTIDE_WORKSPACE_ROOT="$WORKSPACE" \
  AGENTIDE_CHART_DIR="$WORKSPACE/.agent-hippo/analytics/views/star-visualizer/charts" \
  node .agent-hippo/analytics/views/star-visualizer/scripts/star-data-widget.js
}

mkdir -p data/github-star

echo "== Phase 1: github-star ($REPO) =="
collect

if [[ ! -f "$CSV" ]]; then
  echo "ERROR: Expected CSV not found: $CSV" >&2
  exit 1
fi
echo "CSV: $CSV"

echo "== Phase 2: star-visualizer =="
visualize

if [[ ! -f "$CHART" ]]; then
  echo "ERROR: Expected chart not found: $CHART" >&2
  exit 1
fi
echo "Chart: $CHART"
echo "Done"
