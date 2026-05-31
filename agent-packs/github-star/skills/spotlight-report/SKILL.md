---
name: spotlight-report
description: Produces reusable Spotlight report and export generators from trace analytics queries, including markdown summaries, incident post-mortems, and CSV/JSON data bundles. Use when the user asks for written analytics deliverables.
---

# Spotlight Report

Generate shareable reports and exports from live trace analytics.

## Use This Skill When
- User asks for weekly/monthly summaries
- User asks for incident post-mortems
- User asks for comparisons or export bundles

## Output Paths
Use these environment variables when available:
- `AGENTIDE_SCRIPT_DIR` - save generator scripts
- `AGENTIDE_REPORT_DIR` - markdown reports (`.md`)
- `AGENTIDE_EXPORT_DIR` - data exports (`.csv`, `.json`)
- `AGENTIDE_CHART_DIR` - optional supporting charts

If output paths are missing, ask where files should be saved.

## Non-Negotiable Rules
- Always create reusable scripts in `AGENTIDE_SCRIPT_DIR`.
- Always run scripts immediately after saving.
- Use deterministic filenames (`weekly-summary.md`, `agent-comparison.csv`).
- Include report timestamp and scope/filter metadata.
- Return exact generated file paths.

## Workflow
1. Query baseline data (cost, latency, errors, outliers).
2. Choose report type and depth for the audience.
3. Create report/export generator script(s).
4. Run scripts and verify outputs.
5. Return concise findings with artifact paths.

## Report Types
- **Executive summary**: KPI table, trend notes, recommended actions.
- **Agent comparison**: side-by-side efficiency and reliability metrics.
- **Incident post-mortem**: timeline, root cause, remediation plan.
- **Export bundle**: CSV/JSON data for downstream analysis.

## Markdown Template
```markdown
# Spotlight Report - <title>
Generated: <ISO timestamp>
Scope: <global|workspace>
Filters: project_id=<...>, agent_id=<...>

## Key metrics
| Metric | Value |
|---|---|
| Total cost | ... |
| Requests | ... |
| Avg latency | ... |
| Error rate | ... |

## Findings
1. ...
2. ...

## Recommendations
- [ ] ...
- [ ] ...

## Artifacts
- Chart: ...
- Export: ...
```

## Export Guidelines
- Use CSV for tabular review workflows.
- Use JSON for programmatic workflows.
- Keep schema stable across reruns when possible.

## Optional Packaging
For richer deliverables:
- Use `docx` for Word output
- Use `pptx` for presentation output
- Use `pdf` for PDF output

## Guardrails
- Do not publish claims without query-backed numbers.
- Do not keep report content only in chat; persist scripts and files.
- Keep reports scannable (tables first, prose second).
