#!/usr/bin/env bash
set -euo pipefail
ROOT="${AGENTIDE_WORKSPACE_ROOT:-$(pwd)}"
CHART="${ROOT}/.agent-hippo/analytics/views/star-visualizer/charts/star-data-widget.html"
if [[ ! -f "$CHART" ]]; then
  echo "MISSING: $CHART" >&2
  exit 1
fi
if ! grep -q 'Star History' "$CHART"; then
  echo "INVALID: chart HTML missing expected title" >&2
  exit 1
fi
echo "OK: $CHART"
