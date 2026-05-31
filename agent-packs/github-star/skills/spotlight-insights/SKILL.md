---
name: spotlight-insights
description: Orchestrates Spotlight analytics end-to-end by combining query, visualization, optimization, and reporting workflows. Use when the user asks for a complete analysis package with metrics, charts, reports, exports, and recommendations.
---

# Spotlight Insights

Coordinator skill for end-to-end Spotlight deliverables.

## Scope Constraint (Shipped Agents)
Assume only `.agent-hippo/` paths are visible. Do not rely on extension source code.

## Use This Skill When
- User asks for a complete analytics package (numbers + visuals + report)
- Task spans multiple Spotlight skills
- User wants actionable recommendations with supporting evidence

## Inputs To Confirm
- Objective: cost, latency, reliability, regression, incident, or mixed
- Scope: global or workspace
- Filters: `agent_id`, `project_id`, time window
- Deliverables: chart, report, export, post-mortem, or bundle
- Data mode: trace-only vs includes external data
- Audience depth: operator brief vs executive summary

## Paths
Prefer env vars:
- `AGENTIDE_SCRIPT_DIR`
- `AGENTIDE_CHART_DIR`
- `AGENTIDE_REPORT_DIR`
- `AGENTIDE_EXPORT_DIR`

If missing, use `.agent-hippo/analytics/views/<view-id>/{scripts,charts,reports,exports}`.

## Shared Spotlight Execution Contract (Required)
1. Create/update reusable scripts under target view `scripts/`.
2. Register scripts in `.agent-hippo/analytics/panel/views*.yaml`.
3. Set `activeViewId` to target view by default (unless user says otherwise).
4. Run scripts with deterministic outputs.
5. Verify artifacts exist before reporting success.
6. Return script + artifact paths in final response.
7. For external data: include source citations + method note.

## Orchestration Workflow
1. **Query baseline (`spotlight-query`)**
   - Run baseline/outlier queries for trace-mode objectives.
   - Capture concrete metrics/IDs (session/request/version).
2. **Generate visuals (`spotlight-visualize`)**
   - Produce deterministic chart artifacts.
   - Follow shared execution contract.
3. **Generate report/export (`spotlight-report`)**
   - Produce markdown plus optional CSV/JSON outputs.
4. **Optimization pass (`spotlight-optimize`, when requested)**
   - Convert findings into prioritized actions with expected impact.
5. **Assemble final package**
   - Return concise summary + evidence + paths + next steps.

## Failure-Handling Matrix (Required)
- Query unavailable but external-data request is valid → continue with external-data mode and label limitations.
- `views*.yaml` missing → create minimal config then proceed.
- Script ran but artifact missing → fail step, diagnose path/write issues, rerun.
- External source flaky → retry + fallback transport + warning; produce partial outputs when possible.

## Required Quality Checks
- Every claim is backed by query output or cited external data.
- Every artifact path is verified on disk.
- Scripts are re-runnable.
- Recommendations include impact and rationale.

## Delivery Template
```markdown
## Spotlight Insights: <scope>

### What was generated
- Charts: ...
- Report: ...
- Exports: ...

### Key findings
1. ...
2. ...

### Recommended actions
- [ ] P0 ...
- [ ] P1 ...

### Artifact paths
- Script: ...
- Chart: ...
- Report: ...
- Export: ...

### Data sources / method
- Sources: ...
- Method: ...
```

## Guardrails
- Do not skip validation before chart/report generation.
- Do not mix scopes without explicit labels.
- Keep outputs operator-focused and concise.
