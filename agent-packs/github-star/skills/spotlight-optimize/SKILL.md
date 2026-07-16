---
name: spotlight-optimize
description: Identifies cost and performance optimization opportunities from Spotlight trace data using quantitative heuristics and prioritized actions. Use when the user asks to reduce spend, prevent loops, or compare efficiency across models, agents, and versions.
---

# Spotlight Optimize

Analyze local trace data and return measurable optimization actions.

## Use This Skill When
- User asks to lower costs or improve latency/reliability
- User suspects model overuse, retries, or tool loops
- User asks whether a new version regressed

## Query Presets
`query-analytics.sh` is bundled with this skill (`scripts/query-analytics.sh`).

```bash
scripts/query-analytics.sh --cost
scripts/query-analytics.sh --cost-by-model
scripts/query-analytics.sh --cost-per-request
scripts/query-analytics.sh --largest-requests
scripts/query-analytics.sh --tool-loops <session-id>
scripts/query-analytics.sh --compare-versions <agent-id>
scripts/query-analytics.sh --problems
```

Message-debug guidance:
- Use `scripts/query-analytics.sh --session-debug <session-id>` before concluding a request is wasting tokens or looping.
- Use `scripts/query-analytics.sh --session-last <session-id> [N]` when you need the latest user/assistant turns behind a cost spike.
- Multipart messages are previewed as per-part tails in chat; the script emits a local artifact path with the full extracted text when previews are clipped.

## Optimization Workflow
1. **Baseline spend**
   - Total cost, top models/agents, avg cost per request.
2. **Find high-impact waste**
   - Prompt bloat, repeated calls, loop patterns, model over-tiering.
3. **Map root causes**
   - Prompt design, routing policy, retries, tool behavior, version deltas.
4. **Prioritize fixes**
   - Rank by expected impact x implementation effort.
5. **Define validation**
   - Specify queries and success criteria for post-change checks.

## Heuristics (Guidance, Not Hard Rules)
- **Model over-tiering:** low-complexity requests frequently use expensive tiers.
- **Prompt bloat:** repeated high input-token outliers.
- **Retry churn:** high `llm_calls` per request.
- **Tool loops:** repeated identical tool calls in one request/session.
- **Version regression:** worse avg cost/tokens/latency in newer versions.

## Recommendation Format
Each recommendation should include:
- Problem signal with metric
- Proposed change
- Expected impact (`$`, `%`, latency, or error-rate)
- Validation query to confirm outcome

Example:
> Route low-complexity requests to a cheaper model. 42% of requests are below 2K input tokens but currently use high-cost tiers. Estimated savings: 18-25% of model spend. Validate with `--cost-by-model` and `--cost-per-request` after rollout.

## Validation Loop
After changes are deployed:
1. Run comparable workloads.
2. Re-run baseline queries (`--cost`, `--cost-by-model`, `--cost-per-request`).
3. Compare versions (`--compare-versions <agent-id>`).
4. Confirm reliability (`--errors`, `--problems`).

## Output Template
```markdown
## Optimization Analysis: <scope>

### Current state
- Total cost: ...
- Top cost drivers: ...

### Opportunities
1. [Title] - expected impact ...
2. [Title] - expected impact ...

### Action plan
- [ ] P0 ...
- [ ] P1 ...

### Validation
- Query: ...
- Success criteria: ...
```

## Guardrails
- Avoid generic advice without numeric evidence.
- Separate confirmed findings from hypotheses.
- Prefer a few high-confidence actions over long checklists.
