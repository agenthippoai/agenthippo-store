---
name: spotlight-query
description: Query and analyze agent session traces — costs, tool usage, regressions, and request debugging. Uses DuckDB on local OTEL traces. Query Tool scripts/query-analytics.sh — DuckDB-based query tool with pre-built queries and schema check.
---

# Spotlight Query

Analyze agent session data from local OTEL traces. All data stays local.

## Data Model

**Traces** (`~/.{{BRAND_FOLDER}}/analytics/traces/*.jsonl`)

Each LLM call produces a span with:
- `cost`, `input_tokens`, `output_tokens`, `model`, `duration_ms`
- `session_id` — groups calls into one conversation
- `request_id` — groups calls for one user message (multiple LLM calls per request is common)
- `project_id` — workspace-level grouping
- `agent_id`, `agent_version`, `source`, `engine` — enriched metadata (automatic for {{AGENT_BRAND}} agents)

Canonical source for these IDs in queries:
- `metadata.requester_custom_headers` via `x-litellm-metadata-*` keys

**Session Events** (`~/.{{BRAND_FOLDER}}/analytics/sessions/<session_id>.jsonl`)


⚠️ **CRITICAL: `model_calls.input_messages_raw`, `model_calls.output_messages_raw`, and `metadata.requester_custom_headers` can be very large (MB-scale per row).**
- For broad/unknown queries, always write SQL output to a tmp artifact first (for example `~/.{{BRAND_FOLDER}}/analytics/tmp/...`) instead of printing full rows to chat.
- Then drill down in stages: `raw artifact -> summary (row count + key ids/timestamps) -> filtered candidates -> final answer`.
- Never paste raw blob columns to chat by default; extract only needed fields (`role`, `ts`, `content_text`), render multipart messages as per-part tail previews in chat, and keep the full extracted message text in a local artifact.

## Query Tool

`scripts/query-analytics.sh` — DuckDB-based query tool with pre-built queries.

**Schema-first workflow (always do this before custom SQL):**
- Verify flags and built-ins: `scripts/query-analytics.sh --help`
- Inspect indexed table schema via script SQL passthrough:
  - `scripts/query-analytics.sh --sql "DESCRIBE model_calls;"`


The "Data Model" section above describes the *conceptual* LLM span attributes from raw OTEL traces. The **indexed DuckDB `spans` table flattens these into columns**:`


**Runtime guidance (important):**
- Use indexed analytics DB (`~/.{{BRAND_FOLDER}}/analytics/traces/analytics.duckdb`, table `spans`) for routine dashboard/skill analysis.
- Avoid `read_json(...*.jsonl)` in repeated runtime queries; use it only for indexing/recovery workflows.
- Respect DuckDB runtime controls when provided:
  - `AGENTIDE_DUCKDB_MEMORY_LIMIT_MB`
  - `AGENTIDE_DUCKDB_THREADS`
  - `AGENTIDE_DUCKDB_QUERY_TIMEOUT_SECONDS`
  - `AGENTIDE_DUCKDB_TEMP_DIRECTORY`
- If indexed DB is missing/stale, reindex/setup first instead of repeatedly scanning JSONL.
- For dashboard-facing queries, default to `FROM spans` with bounded result sizes (`LIMIT`/top-N).

**Indexing trigger (important):**
- The indexing script is bundled with the extension (`scripts/analytics/index-traces.py`).
- There is currently no stable public CLI entrypoint such as `agenthippo spotlight index`.
- For supported manual triggering, use Spotlight status in VS Code (`Show Spotlight Status` -> `Indexing`).
- In agent workflows, treat reindex as setup/recovery and avoid assuming a guaranteed command-line verb exists.

```bash
duckdb ~/.{{BRAND_FOLDER}}/analytics/traces/analytics.duckdb -c "SELECT COUNT(*) FROM spans;"
```

```bash
chmod +x scripts/query-analytics.sh
scripts/query-analytics.sh --help     # see all flags
scripts/query-analytics.sh --cost     # total cost summary
scripts/query-analytics.sh --problems # find outlier sessions
```

**Key capabilities:**
- Cost breakdowns: by session, model, agent, engine, framework, request
- Debugging: session details, compact session debug bundle, request details, unified timeline
- Regression: version comparison, top expensive sessions
- Health: errors, latency percentiles, statistical outliers
- Tools: loop detection, usage stats

Recommended agent-first entrypoint:
- `scripts/query-analytics.sh --session-debug <session-id>`
  - Returns a bounded bundle with summary, recent requests, tool signals, and latest message previews.
  - Message previews stay compact by default and may emit an artifact path under `~/.{{BRAND_FOLDER}}/analytics/tmp/` with the full extracted message content for the selected rows.

### Common Query Pattern: Latest Messages in a Session

```bash
scripts/query-analytics.sh --sql "
SELECT created_at, agent_id, span_name, model, ROUND(cost, 6) AS cost, duration_ms
FROM spans
WHERE session_id = '<SESSION_ID>'
ORDER BY created_at DESC
LIMIT 10
"
```

For custom analysis: `--sql "SELECT ..."` — the script exposes reusable CTEs (`${BASE_QUERY}`, `${EXTRACT_ATTRS}`) documented in `references/otel-schema.md`.

If you orchestrate queries from Python, prefer running wrapper scripts with `uv run ...` when Python dependencies are involved elsewhere in the workflow. Avoid relying on global `python3` package state.

## Token-Efficient Query Workflow (important)

When running analytics, keep tool outputs small to reduce chat context/token usage.

- Prefer SQL-side reduction first: select only needed columns, filter early (`WHERE`), aggregate (`GROUP BY`), and cap rows (`LIMIT`).
- For potentially large outputs, write/pipe results to a local file (do not print large blobs to chat).
- Store intermediate artifacts under `~/.{{BRAND_FOLDER}}/analytics/tmp/` (or another local temp path).
- In chat, report only:
  - file path
  - row count
- Read back only targeted slices needed for the user request (specific offsets/sections), not whole files.
- Use staged drill-down: broad summary query → narrowed query → detailed evidence query.
- Avoid `SELECT *` on high-payload tables (`model_calls`) unless explicitly debugging internals.
- On message extraction, never return `input_messages_raw` / `output_messages_raw` directly by default; aggregate text-bearing message parts into `content_text`, build chat previews from per-part tails, and store full extracted text in a local artifact when needed.

Example pattern:

```bash
# 1) Save full result locally
scripts/query-analytics.sh --sql "SELECT ..." > ~/.{{BRAND_FOLDER}}/analytics/tmp/session-detail.tsv

# 2) Return a bounded preview to chat
scripts/query-analytics.sh --sql "SELECT ... LIMIT 20"

# 3) Follow up with targeted reads/queries only as needed
```

### Large-Payload Safe Message Extraction

`model_calls.input_messages_raw` and `model_calls.output_messages_raw` can be MB-scale per row.
Use two-step SQL: first isolate the latest relevant call, then extract just message text.

Latest user text for a session:
```bash
scripts/query-analytics.sh --sql "
WITH latest_call AS (
  SELECT start_ms, input_messages_raw
  FROM model_calls
  WHERE session_id = '<SESSION_ID>'
  ORDER BY start_ms DESC
  LIMIT 1
),
messages AS (
  SELECT
    CAST(message.key AS BIGINT) + 1 AS seq_in_session,
    LOWER(COALESCE(json_extract_string(message.value, '$.role'), 'unknown')) AS role,
    message.value AS message_json,
    to_timestamp((SELECT start_ms FROM latest_call) / 1000.0) AS ts
  FROM latest_call, json_each(COALESCE(input_messages_raw, '[]'::JSON)) message
),
expanded AS (
  SELECT
    messages.seq_in_session,
    messages.role,
    COALESCE(
      NULLIF(string_agg(
        COALESCE(
          NULLIF(json_extract_string(part.value, '$.text'), ''),
          NULLIF(json_extract_string(part.value, '$.content'), '')
        ),
        '\n' ORDER BY CAST(part.key AS BIGINT)
      ), ''),
      COALESCE(
        NULLIF(json_extract_string(messages.message_json, '$.text'), ''),
        NULLIF(json_extract_string(messages.message_json, '$.content'), ''),
        ''
      )
    ) AS content_text,
    messages.ts
  FROM messages
  LEFT JOIN json_each(COALESCE(json_extract(messages.message_json, '$.parts'), '[]'::JSON)) part ON TRUE
  GROUP BY messages.seq_in_session, messages.role, messages.message_json, messages.ts
)
SELECT ts, role,
  content_text
FROM expanded
WHERE role = 'user' AND content_text <> ''
ORDER BY seq_in_session DESC
LIMIT 1;
"
```

Latest assistant text for a session:
```bash
scripts/query-analytics.sh --sql "
WITH latest_assistant_call AS (
  SELECT start_ms, output_messages_raw
  FROM model_calls
  WHERE session_id = '<SESSION_ID>'
    AND output_messages_raw IS NOT NULL
    AND output_messages_raw <> ''
  ORDER BY start_ms DESC
  LIMIT 1
),
messages AS (
  SELECT
    CAST(message.key AS BIGINT) + 1 AS seq_in_session,
    LOWER(COALESCE(json_extract_string(message.value, '$.role'), 'assistant')) AS role,
    message.value AS message_json,
    to_timestamp((SELECT start_ms FROM latest_assistant_call) / 1000.0) AS ts
  FROM latest_assistant_call, json_each(COALESCE(output_messages_raw, '[]'::JSON)) message
),
expanded AS (
  SELECT
    messages.seq_in_session,
    messages.role,
    COALESCE(
      NULLIF(string_agg(
        COALESCE(
          NULLIF(json_extract_string(part.value, '$.text'), ''),
          NULLIF(json_extract_string(part.value, '$.content'), '')
        ),
        '\n' ORDER BY CAST(part.key AS BIGINT)
      ), ''),
      COALESCE(
        NULLIF(json_extract_string(messages.message_json, '$.text'), ''),
        NULLIF(json_extract_string(messages.message_json, '$.content'), ''),
        ''
      )
    ) AS content_text,
    messages.ts
  FROM messages
  LEFT JOIN json_each(COALESCE(json_extract(messages.message_json, '$.parts'), '[]'::JSON)) part ON TRUE
  GROUP BY messages.seq_in_session, messages.role, messages.message_json, messages.ts
)
SELECT ts, role,
  content_text
FROM expanded
WHERE role = 'assistant' AND content_text <> ''
ORDER BY seq_in_session DESC
LIMIT 1;
"
```


## Quick Filters (Dashboard-aligned)

Use these filters to match the Spotlight dashboard controls:

- **Agent pack filter (`agent_id`)**:
  ```bash
  scripts/query-analytics.sh --sql "
  ${BASE_QUERY},
  extracted AS (${EXTRACT_ATTRS})
  SELECT agent_id, COUNT(*) AS requests, ROUND(SUM(cost), 6) AS total_cost
  FROM extracted
  WHERE agent_id = 'my-agent-pack'
  GROUP BY agent_id
  "
  ```
- **Workspace filter (`project_id`)**:
  ```bash
  scripts/query-analytics.sh --sql "
  ${BASE_QUERY},
  extracted AS (${EXTRACT_ATTRS})
  SELECT project_id, COUNT(*) AS requests, ROUND(SUM(cost), 6) AS total_cost
  FROM extracted
  WHERE project_id = 'my-workspace'
  GROUP BY project_id
  "
  ```

## Analysis Patterns

### Cost Investigation
1. **Broad → narrow**: Start with aggregates (total, by model, by agent), then find outliers (problems, largest requests), then drill into specific sessions/requests.
2. **Cost drivers**: High `input_tokens` = prompt bloat or large context. High `output_tokens` = verbose responses. Many LLM calls per request = loops or retries.

### Debugging a Session
1. **Overview**: Session summary, cost per request within the session.
2. **Anomalies**: Tool loops (same tool >5x), latency spikes, error spans.
3. **Timeline**: Interleave LLM calls with tool events to see cause/effect.

### Regression Detection
Compare versions of an agent: if avg cost or tokens increased, check for new rules in AGENTS.md, expanded context, or changed tool behavior.

### Root Cause Heuristics

| Symptom | Likely cause | What to check |
|---|---|---|
| High cost | Prompt bloat, wrong model tier | `input_tokens` distribution, model breakdown |
| Many LLM calls per request | Tool loops, retries | Tool call patterns, error rate |
| High latency | Large context, slow model | `duration_ms` vs `input_tokens` correlation |
| Inconsistent behavior | No structured output | Output message patterns across requests |

## Output Format

```
## Analysis: <context>

### Summary
- [key metrics]

### Findings
1. [observation with data]
2. [observation with data]

### Recommendations
- [ ] Actionable item with expected impact
```

## If No Traces

Spotlight requires OTEL Collector + LiteLLM with `callbacks: ["otel"]`.

**Options:**

1. **Manual:** Tell user to run **"Setup Spotlight"** from VS Code command palette

2. **Automated (if user agrees):** Use `$AGENTIDE_ANALYTICS_SCRIPTS_DIR` (set by the extension):
   ```bash
   "$AGENTIDE_ANALYTICS_SCRIPTS_DIR/setup-analytics.sh" --check  # verify status
   "$AGENTIDE_ANALYTICS_SCRIPTS_DIR/setup-analytics.sh" --yes    # non-interactive setup
   ```
