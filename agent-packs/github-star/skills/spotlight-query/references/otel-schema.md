# OTEL Schema Reference

Reference for writing custom DuckDB queries against OTEL trace data.

## File Locations

```
~/.{{BRAND_FOLDER}}/analytics/traces/*.jsonl     # OTEL spans (one file per hour)
~/.{{BRAND_FOLDER}}/analytics/sessions/<id>.jsonl # IDE events per session
```

The query script (`scripts/query-analytics.sh`) automatically resolves these paths.

## Trace File Structure

Each `.jsonl` line is a batch with nested spans:

```
resourceSpans[].scopeSpans[].spans[]
```

Each span has:
- `traceId`, `spanId`, `parentSpanId`, `name`
- `startTimeUnixNano`, `endTimeUnixNano`
- `attributes[]` — key-value pairs (the useful data)
- `status.code` — 0=unset, 1=ok, 2=error

## Key Attributes

Cost and tokens:
- `gen_ai.cost.total_cost`, `gen_ai.cost.currency`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`

Model:
- `gen_ai.request.model` (requested), `gen_ai.response.model` (actual)
- Fallback: `llm.openai.model`

Messages (canonical):
- `gen_ai.input.messages` — full input message history snapshot for the call
- `gen_ai.output.messages` — generated assistant output for the call

Important semantics:
- `gen_ai.input.messages` is usually a full prompt snapshot, not an append-only delta.
- Later calls often repeat earlier conversation context in this field.
- For "latest message" debugging, prefer the latest call (or merged indexed row) for a request/session.

Output generation event (optional, event attributes):
- Event name: `gen_ai.output.generated`
- `gen_ai.output.preview`
- `gen_ai.output.length`
- `gen_ai.output.truncated`
- `gen_ai.response.model`

Note: current Spotlight indexed schema stores canonical input/output message attributes. Event-only output fields are available in raw traces unless explicitly indexed.

Canonical analytics metadata source:
- `metadata.requester_custom_headers` (single source of truth)
- Contains:
  - `x-litellm-metadata-session-id`
  - `x-litellm-metadata-user-id`
  - `x-litellm-metadata-project-id`
  - `x-litellm-metadata-request-id`
  - `x-litellm-metadata-agent-id`
  - `x-litellm-metadata-agent-version`
  - `x-litellm-metadata-source`
  - `x-litellm-metadata-engine`

Session/Request IDs:
- `session_id`, `user_id`, `project_id` — grouping dimensions
- `request_id` — single user message (multiple LLM calls per request)

Agent metadata:
- `agent_id`, `agent_version`, `engine`, `source`

Errors:
- `span.name = "Failed Proxy Server Request"`
- `status.code = 2`
- `exception.message`, `exception.type`, `llm.provider.error_code`

## DuckDB Extraction

The query script uses these patterns — reuse them for custom SQL:

```sql
-- Extract attribute value by key
(SELECT a.value.stringValue
 FROM UNNEST(s.attributes) a
 WHERE a.key = 'gen_ai.request.model') as model

-- For numeric values
(SELECT a.value.doubleValue
 FROM UNNEST(s.attributes) a
 WHERE a.key = 'gen_ai.cost.total_cost') as cost

-- Canonical metadata extraction (single source)
NULLIF(regexp_extract(
  (SELECT a.value.stringValue
   FROM UNNEST(s.attributes) a
   WHERE a.key = 'metadata.requester_custom_headers'),
  'x-litellm-metadata-project-id'': ''([^'']+)''', 1
), '') as project_id

-- Duration in ms
(s.endTimeUnixNano - s.startTimeUnixNano) / 1e6 as duration_ms
```

## Using the Script's CTEs

`scripts/query-analytics.sh --sql "..."` exposes:

```sql
${BASE_QUERY}  -- loads and flattens all spans from traces/*.jsonl
${EXTRACT_ATTRS} -- extracts common attributes into columns
```

Example custom query:

```bash
scripts/query-analytics.sh --sql "
WITH base AS (${BASE_QUERY}),
     attrs AS (${EXTRACT_ATTRS})
SELECT model, COUNT(*) as calls, SUM(cost) as total_cost
FROM attrs
WHERE cost > 0
GROUP BY model
ORDER BY total_cost DESC
"
```

## Session Events Structure

`sessions/<id>.jsonl` — one event per line:

```json
{"type":"tool_start","tool":"Read","ts":1699000000000,"args":{...}}
{"type":"tool_end","tool":"Read","ts":1699000001000,"result":"success"}
{"type":"file_edit","path":"/src/app.ts","ts":1699000002000}
```

Common event types: `tool_start`, `tool_end`, `file_read`, `file_edit`, `shell_command`, `llm_start`, `llm_end`.

## Filtering Tips

LLM call spans (have cost data):
```sql
WHERE cost IS NOT NULL AND cost > 0
```

Error spans:
```sql
WHERE span_name = 'Failed Proxy Server Request'
   OR status_code = 2
```

Specific session:
```sql
WHERE session_id = 'abc123'
```

Time range:
```sql
WHERE start_time > now() - INTERVAL 24 HOUR
```
