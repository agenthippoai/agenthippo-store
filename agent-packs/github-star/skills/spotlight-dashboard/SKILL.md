---
name: spotlight-dashboard
description: Customize the Spotlight dashboard to visualize charts, interactive js, HTML widgets, or general presentation of images, reports. Use this skill when you need to wire scripts/views or adjust dashboard rendering behavior.
---

# Spotlight Dashboard

Wire scripts/views and keep dashboard artifacts discoverable.

## Scope Constraint (Shipped Agents)
Assume only `.agent-hippo/` paths are visible. Do not rely on extension source files.

## View Config Discovery (config-first)
1. Inspect `.agent-hippo/analytics/panel/views*.yaml`.
2. Use `views-team.yaml` for Agent Team `activeViewId` only; eligible views are discovered via the `team` or `fleet` tag in each `view.yaml` (`scope` sets install location).
3. Use `views.yaml` for Spotlight panel policy (`layout`, `refreshOnNavigate`, scripts list).
4. If only one exists, use it.

## Shared Spotlight Execution Contract (Required)
1. Ensure script exists in `.agent-hippo/analytics/views/<view-id>/scripts`.
2. Register script in relevant `panel/views*.yaml` view entry.
3. Set `activeViewId` to target view by default (unless user says otherwise).
4. Ensure artifacts are written under target view `charts/reports/exports`.
5. Verify files exist before reporting success.

## Quick Integration Checklist
- Script path exists.
- Target view entry exists in `views*.yaml`.
- Script is listed under target view `scripts`.
- `activeViewId` points to intended view.
- Chart/report/export files exist under target view directories.

## Create or update `view.yaml` (required for store publish)

Every custom view under `.agent-hippo/analytics/views/<view-id>/` must have a `view.yaml` with store metadata. When creating or updating a view, **always** set `version`, `description`, and `tags`
```yaml
version: 1.0.0          # publish semver (required before sharing to store)
id: <view-id>
name: <Display Name>
description: <One-line summary for the AgentHippo store>
author: <your-name-or-org>
tags:
  - spotlight
  - <domain-keyword>
scope: global           # or workspace
scripts:
  - <widget>.js
system: false
```

| Field | Notes |
|-------|--------|
| `version` | Publish semver (e.g. `1.0.0`); bump on each store release. Do not use a separate `semver` field. |
| `description` | One-line summary for the AgentHippo store — **required** |
| `tags` | 2–5 keywords (`spotlight` plus domain terms) — **required** for discoverability |
| `id`, `name`, `author` | Identity and display; set `author` when known |

- Toolbar **Publish** uses a **full bundle** (scripts + charts/exports + manifest). Use the panel menu **Share scripts only to store** when you only want widget scripts.
- CLI: `agenthippo store publish view/<view-id> --bundle full` (reads `version` from `view.yaml`).

## Failure-Handling Matrix (Required)
- `views.yaml` missing → create minimal `views.yaml` with global/workspace + target view.
- target view missing in config → append view entry (preserve existing views).
- target view folders missing → create `scripts/charts/reports/exports/assets/images`.
- refresh shows no artifacts → verify generated file extensions and locations.

## Dashboard Architecture (summary)
Spotlight discovers artifacts from:
- `${AGENTIDE_CHART_DIR}` (`png`, `svg`, `jpg`, `jpeg`, `html`)
- `${AGENTIDE_REPORT_DIR}` (`md`)
- `${AGENTIDE_EXPORT_DIR}` (`csv`, `json`)

Default persisted state:
- `.agent-hippo/analytics/panel-state/default.json`

## Advanced (only when modifying panel runtime)
Message protocol via `panelApi` (`runtime-bridge.js`):
- Webview → Extension: `requestArtifacts`, `requestSummary`, `requestFilters`, `requestPanelState`, `savePanelState`, `requestArtifactContent`, `openChatWithPrompt`, `refreshCharts`, `copySessionId`, `updateFilters`
- Extension → Webview: `artifactsUpdated`, `artifactContent`, `summaryCards`, `panelStateLoaded`, `disabledChartsUpdated`, `filtersUpdated`, `refreshStarted`, `refreshFinished`, `dataStale`

## Guardrails
- Prefer configuration-level edits over runtime source edits.
- Keep dashboard integrations lightweight and deterministic.
