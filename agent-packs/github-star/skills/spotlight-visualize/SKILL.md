---
name: spotlight-visualize
description: Generates Spotlight analytics charts using Matplotlib or self-contained HTML from DuckDB query results and saves reusable refreshable scripts. Use when the user asks for charts, trends, comparisons, or dashboard visuals.
---

# Spotlight Visualize

Create charts and make them refreshable in the Spotlight panel.

## Scope Constraint (Shipped Agents)
Assume only `.agent-hippo/` paths are visible. Do not depend on extension source code.

## Use This Skill When
- User asks for charts, trends, comparisons, or dashboard visuals
- A report needs supporting visuals
- `spotlight-insights` needs chart generation as one stage

## Data Modes

### 1) Trace Mode (default)
Use Spotlight trace data from `AGENTIDE_TRACES_DIR` + DuckDB.

If you need to inspect recent conversation state before choosing a chart slice:
- `scripts/query-analytics.sh --session-debug <session-id>` for a compact bounded summary
- `scripts/query-analytics.sh --session-last <session-id> [N]` for recent user/assistant turns
- Multipart message previews are rendered as per-part tail excerpts; full extracted text is written to a local artifact path when needed

### 2) External Data Mode (allowed when user asks)
Use external APIs/CSV, parquet, etc. when request is not trace analytics.

External Data Mode requirements:
- cite source(s)
- keep deterministic artifact filenames
- include method note (window/normalization/filters)
- use reliability guards (timeout + retry + fallback transport like `curl`)

## Runtime Paths
Prefer env vars when available:
- `AGENTIDE_SCRIPT_DIR`
- `AGENTIDE_TRACES_DIR`
- `AGENTIDE_CHART_DIR`
- `AGENTIDE_REPORT_DIR`
- `AGENTIDE_EXPORT_DIR`

If missing, use `.agent-hippo` view defaults:
- `.agent-hippo/analytics/views/<view-id>/scripts`
- `.agent-hippo/analytics/views/<view-id>/charts`
- `.agent-hippo/analytics/views/<view-id>/reports`
- `.agent-hippo/analytics/views/<view-id>/exports`

## View Config Discovery (config-first)
1. Inspect `.agent-hippo/analytics/panel/views*.yaml`.
2. Use `views-team.yaml` for team/fleet flows.
3. Use `views.yaml` for standard spotlight/dashboard flows.
4. If only one exists, use it.

## Shared Spotlight Execution Contract (Required)
1. Create reusable script under target view `scripts/` (or `AGENTIDE_SCRIPT_DIR`).
2. Register script in relevant `panel/views*.yaml` entry.
3. Set `activeViewId` to target view by default (unless user says otherwise).
4. Run script with `uv run ...`.
5. Verify artifacts exist before reporting success.
6. Return paths + one concise takeaway.
7. For external data, also return source + method note.

## New View Quick Workflow
1. Create `.agent-hippo/analytics/views/<viewId>/{scripts,charts,reports,exports,assets,images}`.
2. Create/update `.agent-hippo/analytics/views/<viewId>/view.yaml` with **required store metadata** (no placeholders):
   - `version: 1.0.0` — publish semver; bump on each release
   - `description` — one-line store summary
   - `tags` — include `spotlight` plus 2–4 domain keywords (e.g. `cost`, `fleet`, `latency`)
   - `id`, `name`, `author` (when known), `scope`, `scripts`, `system: false`
3. Add script to chosen `panel/views*.yaml`.
4. Set `activeViewId` to `<viewId>` unless user requested otherwise.
5. Run script and verify outputs.

## Python Runtime (Required)
```bash
uv run --with matplotlib python3 "<script-path>.py"
```

## Failure-Handling Matrix (Required)
- `views.yaml` missing → create minimal `views.yaml` with global/workspace + target view.
- target view missing → create view folders + `view.yaml`.
- script runs but no artifacts → treat as failure; print diagnostic and file checks.
- external fetch fails → retry, fallback transport, warn; generate partial outputs if possible.
- ambiguous `views-team.yaml` vs `views.yaml` → apply discovery rules above, then proceed.

## Guardrails
- Do not generate chart code only in chat; persist scripts/files.
- Do not overwrite unrelated scripts/artifacts.
- Do not claim output exists before verifying file paths.
