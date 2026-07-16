#!/usr/bin/env bash
#
# Copyright (c) AgentHippo.ai. All rights reserved.
#
# Query AgentHippo Analytics with DuckDB
#
# Run with --help for full usage. Key queries:
#
#   Cost:      --cost, --cost-by-session, --cost-by-model, --cost-by-pack
#   Debug:     --session <id>, --request <id>, --latest-session
#               --session-messages <id> (parse messages directly from traces)
#   Regress:   --compare-versions <agent>, --top-sessions <agent>
#   Health:    --problems, --errors, --largest-requests, --tool-loops <id>
#   Custom:    --sql "SELECT ..." (can use ${BASE_QUERY} and ${EXTRACT_ATTRS} CTEs)
#

set -euo pipefail

# AGENT_HOME_DIR is set by the extension with the branded directory path
# Falls back to ~/.agent-hippo for manual script runs
AGENT_HOME_DIR="${AGENT_HOME_DIR:-$HOME/.agent-hippo}"
ANALYTICS_DIR="${AGENT_HOME_DIR}/analytics"
BIN_DIR="${AGENT_HOME_DIR}/bin"
# Prefer explicit traces dir from dashboard env; fall back to default analytics path.
TRACES_DIR="${AGENTIDE_TRACES_DIR:-${ANALYTICS_DIR}/traces}"
INDEX_DB_PATH="${AGENTIDE_INDEX_DB_PATH:-${TRACES_DIR}/analytics.duckdb}"
TMP_DIR="${AGENTIDE_ANALYTICS_TMP_DIR:-${ANALYTICS_DIR}/tmp}"
MESSAGE_PREVIEW_CHARS="${AGENTIDE_SPOTLIGHT_MESSAGE_PREVIEW_CHARS:-800}"
MESSAGE_PART_PREVIEW_CHARS="${AGENTIDE_SPOTLIGHT_MESSAGE_PART_PREVIEW_CHARS:-400}"
MESSAGE_OUTPUT_BUDGET_CHARS="${AGENTIDE_SPOTLIGHT_OUTPUT_BUDGET_CHARS:-12000}"
TRACE_EVENT_PREVIEW_LIMIT="${AGENTIDE_SPOTLIGHT_TRACE_EVENT_PREVIEW_LIMIT:-12}"
SESSION_DEBUG_REQUEST_LIMIT="${AGENTIDE_SPOTLIGHT_SESSION_DEBUG_REQUEST_LIMIT:-6}"
SESSION_DEBUG_TOOL_LIMIT="${AGENTIDE_SPOTLIGHT_SESSION_DEBUG_TOOL_LIMIT:-8}"

# Find duckdb binary
# Use indexed DB when available for fast session/message queries.
find_duckdb() {
    if command -v duckdb &> /dev/null; then
        echo "duckdb"
    elif [[ -x "${BIN_DIR}/duckdb" ]]; then
        echo "${BIN_DIR}/duckdb"
    else
        echo "ERROR: DuckDB not found. Run install-analytics.sh first." >&2
        exit 1
    fi
}

DUCKDB=$(find_duckdb)

# Check if traces exist
check_traces() {
    if ! ls "${TRACES_DIR}"/*.jsonl &> /dev/null; then
        echo "No trace files found in ${TRACES_DIR}/"
        echo "Make sure OTEL Collector is running and LiteLLM has the 'otel' callback enabled."
        exit 0
    fi
}

has_indexed_db() {
    if [[ ! -f "${INDEX_DB_PATH}" ]]; then
        return 1
    fi

    local table_count
    table_count="$(${DUCKDB} -readonly "${INDEX_DB_PATH}" -csv -c "
        SELECT COUNT(DISTINCT table_name)
        FROM information_schema.tables
        WHERE table_name IN ('model_calls', 'sessions', 'turns');
    " 2>/dev/null | tail -n 1)"

    [[ "${table_count}" == "3" ]]
}

has_indexed_table() {
    local table_name="$1"
    if [[ ! -f "${INDEX_DB_PATH}" ]]; then
        return 1
    fi
    local found
    found="$(${DUCKDB} -readonly "${INDEX_DB_PATH}" -csv -c "
        SELECT COUNT(*)
        FROM information_schema.tables
        WHERE table_name = '$(escape_sql_literal "${table_name}")';
    " 2>/dev/null | tail -n 1)"
    [[ "${found}" == "1" ]]
}

run_duckdb_sql() {
    local sql="$1"
    if [[ -f "${INDEX_DB_PATH}" ]]; then
        ${DUCKDB} -readonly "${INDEX_DB_PATH}" -c "${sql}"
    else
        ${DUCKDB} -c "${sql}"
    fi
}

run_duckdb_json_sql() {
    local sql="$1"
    if [[ -f "${INDEX_DB_PATH}" ]]; then
        ${DUCKDB} -readonly "${INDEX_DB_PATH}" -json -c "${sql}"
    else
        ${DUCKDB} -json -c "${sql}"
    fi
}

escape_sql_literal() {
    local value="${1:-}"
    printf "%s" "${value//\'/'\'}"
}

sanitize_artifact_label() {
    local value="${1:-artifact}"
    printf "%s" "${value}" | tr -cs 'A-Za-z0-9._-' '_'
}

ensure_tmp_dir() {
    mkdir -p "${TMP_DIR}"
}

make_artifact_path() {
    local prefix="${1:-spotlight-query}"
    local suffix="${2:-txt}"
    local path
    ensure_tmp_dir
    path="$(mktemp "${TMP_DIR}/$(sanitize_artifact_label "${prefix}")-XXXXXX")"
    if [[ -n "${suffix}" ]]; then
        mv "${path}" "${path}.${suffix}"
        path="${path}.${suffix}"
    fi
    printf "%s\n" "${path}"
}

format_messages_rows() {
    python3 -c '
import os
import json
import sys
import textwrap

role_colors = {
    "system": "\033[33m",
    "user": "\033[36m",
    "assistant": "\033[32m",
    "tool": "\033[35m",
}
reset = "\033[0m"
budget = max(1000, int(os.environ.get("MESSAGE_OUTPUT_BUDGET_CHARS", "12000")))
artifact_path = os.environ.get("MESSAGE_ARTIFACT_PATH", "")

def format_content(content, indent=2):
    if content is None:
        content = ""
    content = str(content)
    prefix = " " * indent
    return textwrap.fill(content, width=100, initial_indent=prefix, subsequent_indent=prefix)

payload = sys.stdin.read().strip()
if not payload:
    print("(no messages found)")
    sys.exit(0)

rows = json.loads(payload)
if not rows:
    print("(no messages found)")
    sys.exit(0)

rendered_blocks = []
artifact_lines = []
truncated_rows = 0
for row in rows:
    seq = row.get("seq_in_session")
    role = str(row.get("role") or "unknown")
    ts = row.get("ts") or ""
    artifact_content = str(row.get("artifact_content_text") or row.get("content_text") or "")
    content = str(row.get("content_text") or "")
    content_chars = len(artifact_content)
    preview_part_count = max(1, int(row.get("preview_part_count") or 1))
    truncated_part_count = max(0, int(row.get("truncated_part_count") or 0))
    is_truncated = bool(row.get("is_truncated"))
    color = role_colors.get(role, "")
    if seq is None:
        header = f"\n{color}{role.upper()}{reset} {ts}"
    else:
        header = f"\n{color}[{seq}] {role.upper()}{reset} {ts}"
    suffix = ""
    artifact_suffix = ""
    if is_truncated:
        truncated_rows += 1
        if preview_part_count > 1:
            suffix = (
                f"\n  [per-part tail preview: {preview_part_count} parts, "
                f"{truncated_part_count} truncated, {content_chars} chars total]"
            )
            artifact_suffix += (
                f"\n  [preview used per-part tail excerpts across {preview_part_count} parts; "
                f"full extracted content retained]"
            )
        else:
            visible_chars = len(content) - 3 if content.startswith("...") else len(content)
            suffix = f"\n  [tail preview truncated: showing last {min(content_chars, visible_chars)} of {content_chars} chars]"
            artifact_suffix += f"\n  [tail preview truncated from {content_chars} chars]"
    block = f"{header}\n{format_content(content)}{suffix}"
    rendered_blocks.append(block)
    artifact_lines.append(f"{header}\n{format_content(artifact_content)}{artifact_suffix}")

total_chars = 0
printed = 0
for block in rendered_blocks:
    projected = total_chars + len(block)
    if printed > 0 and projected > budget:
        break
    print(block)
    total_chars = projected
    printed += 1

omitted = len(rendered_blocks) - printed
artifact_needed = bool(artifact_path) and (
    omitted > 0 or truncated_rows > 0 or len(rendered_blocks) > 8
)
if artifact_needed:
    with open(artifact_path, "w", encoding="utf-8") as handle:
        handle.write("Spotlight Query message artifact\n")
        handle.write(f"rows={len(rendered_blocks)} truncated_rows={truncated_rows}\n")
        handle.write("\n".join(artifact_lines))
        handle.write("\n")

if omitted > 0:
    print(f"\nOutput clipped after {printed} rows to stay within {budget} chars.")
    if artifact_path:
        print(f"Artifact: {artifact_path}")
elif artifact_needed:
    print(f"\nArtifact: {artifact_path}")
    '
}

query_session_last_messages() {
    local session_id="$1"
    local limit="${2:-8}"
    local escaped_session_id
    local artifact_path
    escaped_session_id="$(escape_sql_literal "${session_id}")"

    if ! [[ "${limit}" =~ ^[0-9]+$ ]]; then
        echo "Limit must be numeric"
        exit 1
    fi

    if has_indexed_db; then
        artifact_path="$(make_artifact_path "session-last-$(sanitize_artifact_label "${session_id}")" "txt")"
        echo "📊 Last ${limit} User/Assistant Messages (safe preview): ${session_id}"
        echo "================================================================"
        run_duckdb_json_sql "
        WITH latest_call AS (
            SELECT
                trace_id,
                turn_id,
                request_id,
                start_ms,
                input_messages_raw,
                output_messages_raw
            FROM model_calls
            WHERE session_id = '${escaped_session_id}'
            ORDER BY start_ms DESC
            LIMIT 1
        ),
        input_messages AS (
            SELECT
                CAST(message.key AS BIGINT) + 1 AS seq_in_session,
                LOWER(COALESCE(
                    json_extract_string(message.value, '$.role'),
                    json_extract_string(message.value, '$.message.role'),
                    'unknown'
                )) AS role,
                message.value AS message_json,
                to_timestamp((SELECT start_ms FROM latest_call) / 1000.0) AS ts,
                (SELECT turn_id FROM latest_call) AS turn_id,
                (SELECT trace_id FROM latest_call) AS trace_id,
                COALESCE(
                    NULLIF(json_extract_string(message.value, '$.text'), ''),
                    NULLIF(json_extract_string(message.value, '$.message.content'), ''),
                    NULLIF(json_extract_string(message.value, '$.content'), ''),
                    ''
                ) AS fallback_text
            FROM latest_call,
                 json_each(COALESCE(input_messages_raw, '[]'::JSON)) message
        ),
        input_parts AS (
            SELECT
                raw_parts.seq_in_session,
                raw_parts.part_index,
                raw_parts.part_text,
                CASE
                    WHEN length(raw_parts.part_text) > ${MESSAGE_PART_PREVIEW_CHARS}
                        THEN '...' || right(raw_parts.part_text, ${MESSAGE_PART_PREVIEW_CHARS})
                    ELSE raw_parts.part_text
                END AS part_preview_text,
                length(raw_parts.part_text) > ${MESSAGE_PART_PREVIEW_CHARS} AS part_is_truncated
            FROM (
                SELECT
                    input_messages.seq_in_session,
                    CAST(part.key AS BIGINT) AS part_index,
                    LOWER(COALESCE(json_extract_string(part.value, '$.type'), '')) AS part_type,
                    part_text
                FROM input_messages
                LEFT JOIN json_each(
                    CASE
                        WHEN json_type(json_extract(input_messages.message_json, '$.parts')) = 'ARRAY'
                            THEN json_extract(input_messages.message_json, '$.parts')
                        WHEN json_type(json_extract(input_messages.message_json, '$.message.parts')) = 'ARRAY'
                            THEN json_extract(input_messages.message_json, '$.message.parts')
                        WHEN json_type(json_extract(input_messages.message_json, '$.content')) = 'ARRAY'
                            THEN json_extract(input_messages.message_json, '$.content')
                        WHEN json_type(json_extract(input_messages.message_json, '$.message.content')) = 'ARRAY'
                            THEN json_extract(input_messages.message_json, '$.message.content')
                        ELSE '[]'::JSON
                    END
                ) part ON TRUE
                CROSS JOIN (
                    SELECT COALESCE(
                        NULLIF(json_extract_string(part.value, '$.text'), ''),
                        NULLIF(json_extract_string(part.value, '$.content'), ''),
                        ''
                    ) AS part_text
                ) extracted
            ) raw_parts
            WHERE raw_parts.part_type NOT IN ('thinking', 'signature', 'tool_result')
              AND raw_parts.part_text <> ''
        ),
        input_expanded AS (
            SELECT
                input_messages.seq_in_session,
                input_messages.role,
                COALESCE(
                    NULLIF(string_agg(input_parts.part_text, '\n' ORDER BY input_parts.part_index), ''),
                    input_messages.fallback_text
                ) AS content_text,
                COALESCE(
                    NULLIF(string_agg(input_parts.part_preview_text, '\n...\n' ORDER BY input_parts.part_index), ''),
                    CASE
                        WHEN length(input_messages.fallback_text) > ${MESSAGE_PART_PREVIEW_CHARS}
                            THEN '...' || right(input_messages.fallback_text, ${MESSAGE_PART_PREVIEW_CHARS})
                        ELSE input_messages.fallback_text
                    END
                ) AS preview_text,
                CASE
                    WHEN COUNT(input_parts.part_text) > 0 THEN COUNT(input_parts.part_text)
                    WHEN input_messages.fallback_text <> '' THEN 1
                    ELSE 0
                END AS preview_part_count,
                CASE
                    WHEN COUNT(input_parts.part_text) > 0 THEN SUM(CASE WHEN input_parts.part_is_truncated THEN 1 ELSE 0 END)
                    WHEN length(input_messages.fallback_text) > ${MESSAGE_PART_PREVIEW_CHARS} THEN 1
                    ELSE 0
                END AS truncated_part_count,
                input_messages.ts,
                input_messages.turn_id,
                input_messages.trace_id
            FROM input_messages
            LEFT JOIN input_parts
              ON input_parts.seq_in_session = input_messages.seq_in_session
            GROUP BY
                input_messages.seq_in_session,
                input_messages.role,
                input_messages.fallback_text,
                input_messages.ts,
                input_messages.turn_id,
                input_messages.trace_id
        ),
        output_messages AS (
            SELECT
                (SELECT COALESCE(MAX(seq_in_session), 0) FROM input_expanded) + CAST(message.key AS BIGINT) + 1 AS seq_in_session,
                LOWER(COALESCE(
                    json_extract_string(message.value, '$.role'),
                    json_extract_string(message.value, '$.message.role'),
                    'assistant'
                )) AS role,
                message.value AS message_json,
                to_timestamp((SELECT start_ms FROM latest_call) / 1000.0) AS ts,
                (SELECT turn_id FROM latest_call) AS turn_id,
                (SELECT trace_id FROM latest_call) AS trace_id,
                COALESCE(
                    NULLIF(json_extract_string(message.value, '$.text'), ''),
                    NULLIF(json_extract_string(message.value, '$.message.content'), ''),
                    NULLIF(json_extract_string(message.value, '$.content'), ''),
                    ''
                ) AS fallback_text
            FROM latest_call,
                 json_each(COALESCE(output_messages_raw, '[]'::JSON)) message
        ),
        output_parts AS (
            SELECT
                raw_parts.seq_in_session,
                raw_parts.part_index,
                raw_parts.part_text,
                CASE
                    WHEN length(raw_parts.part_text) > ${MESSAGE_PART_PREVIEW_CHARS}
                        THEN '...' || right(raw_parts.part_text, ${MESSAGE_PART_PREVIEW_CHARS})
                    ELSE raw_parts.part_text
                END AS part_preview_text,
                length(raw_parts.part_text) > ${MESSAGE_PART_PREVIEW_CHARS} AS part_is_truncated
            FROM (
                SELECT
                    output_messages.seq_in_session,
                    CAST(part.key AS BIGINT) AS part_index,
                    LOWER(COALESCE(json_extract_string(part.value, '$.type'), '')) AS part_type,
                    part_text
                FROM output_messages
                LEFT JOIN json_each(
                    CASE
                        WHEN json_type(json_extract(output_messages.message_json, '$.parts')) = 'ARRAY'
                            THEN json_extract(output_messages.message_json, '$.parts')
                        WHEN json_type(json_extract(output_messages.message_json, '$.message.parts')) = 'ARRAY'
                            THEN json_extract(output_messages.message_json, '$.message.parts')
                        WHEN json_type(json_extract(output_messages.message_json, '$.content')) = 'ARRAY'
                            THEN json_extract(output_messages.message_json, '$.content')
                        WHEN json_type(json_extract(output_messages.message_json, '$.message.content')) = 'ARRAY'
                            THEN json_extract(output_messages.message_json, '$.message.content')
                        ELSE '[]'::JSON
                    END
                ) part ON TRUE
                CROSS JOIN (
                    SELECT COALESCE(
                        NULLIF(json_extract_string(part.value, '$.text'), ''),
                        NULLIF(json_extract_string(part.value, '$.content'), ''),
                        ''
                    ) AS part_text
                ) extracted
            ) raw_parts
            WHERE raw_parts.part_type NOT IN ('thinking', 'signature', 'tool_result')
              AND raw_parts.part_text <> ''
        ),
        output_expanded AS (
            SELECT
                output_messages.seq_in_session,
                output_messages.role,
                COALESCE(
                    NULLIF(string_agg(output_parts.part_text, '\n' ORDER BY output_parts.part_index), ''),
                    output_messages.fallback_text
                ) AS content_text,
                COALESCE(
                    NULLIF(string_agg(output_parts.part_preview_text, '\n...\n' ORDER BY output_parts.part_index), ''),
                    CASE
                        WHEN length(output_messages.fallback_text) > ${MESSAGE_PART_PREVIEW_CHARS}
                            THEN '...' || right(output_messages.fallback_text, ${MESSAGE_PART_PREVIEW_CHARS})
                        ELSE output_messages.fallback_text
                    END
                ) AS preview_text,
                CASE
                    WHEN COUNT(output_parts.part_text) > 0 THEN COUNT(output_parts.part_text)
                    WHEN output_messages.fallback_text <> '' THEN 1
                    ELSE 0
                END AS preview_part_count,
                CASE
                    WHEN COUNT(output_parts.part_text) > 0 THEN SUM(CASE WHEN output_parts.part_is_truncated THEN 1 ELSE 0 END)
                    WHEN length(output_messages.fallback_text) > ${MESSAGE_PART_PREVIEW_CHARS} THEN 1
                    ELSE 0
                END AS truncated_part_count,
                output_messages.ts,
                output_messages.turn_id,
                output_messages.trace_id
            FROM output_messages
            LEFT JOIN output_parts
              ON output_parts.seq_in_session = output_messages.seq_in_session
            GROUP BY
                output_messages.seq_in_session,
                output_messages.role,
                output_messages.fallback_text,
                output_messages.ts,
                output_messages.turn_id,
                output_messages.trace_id
        ),
        expanded AS (
            SELECT * FROM input_expanded
            UNION ALL
            SELECT * FROM output_expanded
        ),
        filtered AS (
            SELECT *
            FROM expanded
            WHERE role IN ('user', 'assistant')
              AND content_text <> ''
        ),
        last_rows AS (
            SELECT *
            FROM filtered
            ORDER BY seq_in_session DESC
            LIMIT ${limit}
        )
        SELECT
            seq_in_session,
            role,
            preview_text AS content_text,
            content_text AS artifact_content_text,
            length(content_text) AS content_chars,
            truncated_part_count > 0 AS is_truncated,
            preview_part_count,
            truncated_part_count,
            ts,
            turn_id,
            trace_id
        FROM last_rows
        ORDER BY seq_in_session ASC;
        " | MESSAGE_PREVIEW_CHARS="${MESSAGE_PREVIEW_CHARS}" MESSAGE_OUTPUT_BUDGET_CHARS="${MESSAGE_OUTPUT_BUDGET_CHARS}" MESSAGE_ARTIFACT_PATH="${artifact_path}" format_messages_rows
        return
    fi

    echo "Indexed analytics DB not found; falling back to trace parsing."
    query_session_messages "${session_id}" "${limit}"
}

query_session_tools() {
    local session_id="$1"
    local escaped_session_id
    escaped_session_id="$(escape_sql_literal "${session_id}")"

    if has_indexed_db; then
        echo "🔧 Session Tools: ${session_id}"
        echo "=============================="
        run_duckdb_sql "
        SELECT
            call_ts,
            tool_name,
            status,
            ROUND(COALESCE(duration_ms, 0), 2) AS duration_ms,
            LEFT(COALESCE(arguments_text, ''), 200) AS arguments_preview,
            LEFT(COALESCE(result_text, ''), 200) AS result_preview,
            COALESCE(error_message, '') AS error_message
        FROM tool_calls
        WHERE session_id = '${escaped_session_id}'
        ORDER BY call_ts;
        "
        return
    fi

    echo "Indexed analytics DB not found; tool-level session history is unavailable without index DB."
    exit 1
}

query_session_summary_fast() {
    local session_id="$1"
    local escaped_session_id
    escaped_session_id="$(escape_sql_literal "${session_id}")"

    if has_indexed_db; then
        echo "📊 Session Summary: ${session_id}"
        echo "==============================="
        run_duckdb_sql "
        SELECT
            session_id,
            COALESCE(agent_id, '') AS agent_id,
            COALESCE(agent_version, '') AS agent_version,
            COALESCE(engine, '') AS engine,
            COALESCE(status, '') AS status,
            started_at,
            ended_at,
            total_turns,
            total_requests,
            ROUND(COALESCE(total_cost_usd, 0), 6) AS total_cost_usd,
            COALESCE(total_tokens, 0) AS total_tokens
        FROM sessions
        WHERE session_id = '${escaped_session_id}'
        LIMIT 1;
        "
        return
    fi

    query_session "${session_id}"
}

query_latest_session_fast() {
    if has_indexed_db; then
        echo "📊 Latest Session"
        echo "================"
        run_duckdb_sql "
        SELECT
            session_id,
            COALESCE(agent_id, '') AS agent_id,
            COALESCE(agent_version, '') AS agent_version,
            COALESCE(engine, '') AS engine,
            COALESCE(status, '') AS status,
            started_at,
            ended_at,
            total_turns,
            total_requests,
            ROUND(COALESCE(total_cost_usd, 0), 6) AS total_cost_usd,
            COALESCE(total_tokens, 0) AS total_tokens
        FROM sessions
        ORDER BY ended_at DESC NULLS LAST, started_at DESC NULLS LAST
        LIMIT 1;
        "
        return
    fi

    query_latest_session
}

query_request_fast() {
    local request_id="$1"
    local escaped_request_id
    escaped_request_id="$(escape_sql_literal "${request_id}")"

    if has_indexed_db; then
        echo "📊 Request: ${request_id}"
        echo "========================="
        run_duckdb_sql "
        SELECT
            model,
            ROUND(COALESCE(total_cost_usd, 0), 6) AS cost,
            prompt_tokens AS input_tokens,
            completion_tokens AS output_tokens,
            ROUND(COALESCE(duration_ms, 0), 2) AS latency_ms,
            COALESCE(turn_id, '') AS turn_id,
            to_timestamp(start_ms / 1000.0) AS timestamp
        FROM model_calls
        WHERE request_id = '${escaped_request_id}'
        ORDER BY start_ms;
        "
        return
    fi

    query_request "${request_id}"
}

query_session_fast() {
    local session_id="$1"
    local escaped_session_id
    escaped_session_id="$(escape_sql_literal "${session_id}")"

    if has_indexed_db; then
        echo "📊 Session: ${session_id}"
        echo "========================="
        run_duckdb_sql "
        SELECT
            model,
            ROUND(COALESCE(total_cost_usd, 0), 6) as cost,
            prompt_tokens as input_tokens,
            completion_tokens as output_tokens,
            ROUND(COALESCE(duration_ms, 0), 2) as latency_ms,
            COALESCE(request_id, '') as request_id,
            to_timestamp(start_ms / 1000.0) as timestamp
        FROM model_calls
        WHERE session_id = '${escaped_session_id}'
        ORDER BY start_ms;
        "
        return
    fi

    query_session "${session_id}"
}

query_cost_by_session_fast() {
    if has_indexed_db; then
        echo "📊 Cost by Session"
        echo "=================="
        run_duckdb_sql "
        SELECT
            session_id,
            ROUND(COALESCE(total_cost_usd, 0), 6) as total_cost,
            COALESCE(total_tokens, 0) as total_tokens,
            total_requests as requests,
            total_turns as turns,
            started_at,
            ended_at
        FROM sessions
        ORDER BY total_cost DESC
        LIMIT 20;
        "
        return
    fi

    query_cost_by_session
}

query_cost_by_model_fast() {
    if has_indexed_db; then
        echo "📊 Cost by Model"
        echo "================"
        run_duckdb_sql "
        SELECT
            COALESCE(model, '(unknown)') as model,
            ROUND(SUM(COALESCE(total_cost_usd, 0)), 6) as total_cost,
            SUM(COALESCE(prompt_tokens, 0)) as input_tokens,
            SUM(COALESCE(completion_tokens, 0)) as output_tokens,
            COUNT(*) as requests,
            ROUND(AVG(COALESCE(duration_ms, 0)), 2) as avg_latency_ms
        FROM model_calls
        GROUP BY model
        ORDER BY total_cost DESC;
        "
        return
    fi

    query_cost_by_model
}

query_cost_by_pack_fast() {
    if has_indexed_db; then
        echo "📊 Cost by Agent"
        echo "================"
        run_duckdb_sql "
        SELECT
            COALESCE(agent_id, '(no agent)') AS agent,
            COALESCE(agent_version, '?') AS version,
            ROUND(SUM(COALESCE(total_cost_usd, 0)), 6) AS total_cost,
            SUM(COALESCE(prompt_tokens, 0)) AS input_tokens,
            SUM(COALESCE(completion_tokens, 0)) AS output_tokens,
            COUNT(*) AS requests
        FROM model_calls
        GROUP BY agent_id, agent_version
        ORDER BY total_cost DESC;
        "
        return
    fi

    query_cost_by_pack
}

query_cost_by_engine_fast() {
    if has_indexed_db; then
        echo "📊 Cost by Engine"
        echo "================="
        run_duckdb_sql "
        SELECT
            COALESCE(engine, '(unknown)') AS engine,
            COALESCE(model, '(unknown)') AS model,
            ROUND(SUM(COALESCE(total_cost_usd, 0)), 6) AS total_cost,
            COUNT(*) AS requests,
            SUM(COALESCE(prompt_tokens, 0)) AS input_tokens,
            SUM(COALESCE(completion_tokens, 0)) AS output_tokens
        FROM model_calls
        GROUP BY engine, model
        ORDER BY total_cost DESC;
        "
        return
    fi

    query_cost_by_engine
}

query_cost_by_source_fast() {
    if has_indexed_db; then
        echo "📊 Cost by Source"
        echo "================="
        run_duckdb_sql "
        SELECT
            COALESCE(source, '(unknown)') AS source,
            COALESCE(model, '(unknown)') AS model,
            ROUND(SUM(COALESCE(total_cost_usd, 0)), 6) AS total_cost,
            COUNT(*) AS requests,
            SUM(COALESCE(prompt_tokens, 0)) AS input_tokens,
            SUM(COALESCE(completion_tokens, 0)) AS output_tokens
        FROM model_calls
        GROUP BY source, model
        ORDER BY total_cost DESC;
        "
        return
    fi

    query_cost_by_source
}

query_total_cost_fast() {
    if has_indexed_db; then
        echo "📊 Total Cost Summary"
        echo "===================="
        run_duckdb_sql "
        SELECT
            ROUND(COALESCE(SUM(total_cost_usd), 0), 6) as total_cost,
            COALESCE(SUM(prompt_tokens), 0) as total_input_tokens,
            COALESCE(SUM(completion_tokens), 0) as total_output_tokens,
            COUNT(*) as total_requests,
            ROUND(AVG(COALESCE(duration_ms, 0)), 2) as avg_latency_ms
        FROM model_calls;
        "
        return
    fi

    query_total_cost
}

query_cost_per_request_fast() {
    local session_id="${1:-}"
    if has_indexed_db; then
        local where_clause="WHERE request_id IS NOT NULL"
        echo "📊 Cost per Request"
        echo "==================="
        if [[ -n "${session_id}" ]]; then
            where_clause="WHERE session_id = '$(escape_sql_literal "${session_id}")' AND request_id IS NOT NULL"
            echo "   Session: ${session_id}"
        fi
        run_duckdb_sql "
        SELECT
            request_id,
            COUNT(*) AS llm_calls,
            ROUND(SUM(COALESCE(total_cost_usd, 0)), 6) AS request_cost,
            SUM(COALESCE(prompt_tokens, 0)) AS input_tokens,
            SUM(COALESCE(completion_tokens, 0)) AS output_tokens,
            ROUND(SUM(COALESCE(duration_ms, 0)), 0) AS total_latency_ms,
            MIN(to_timestamp(start_ms / 1000.0)) AS started_at
        FROM model_calls
        ${where_clause}
        GROUP BY request_id
        ORDER BY MIN(start_ms);
        "
        return
    fi

    query_cost_per_request "${session_id}"
}

query_session_timeline_fast() {
    local session_id="$1"
    local escaped_session_id
    escaped_session_id="$(escape_sql_literal "${session_id}")"

    if has_indexed_db; then
        echo "📊 Session Timeline: ${session_id}"
        run_duckdb_sql "
        SELECT
            to_timestamp(start_ms / 1000.0) AS event_ts,
            'llm_call' AS event_type,
            '' AS role,
            COALESCE(model, '') AS model,
            '' AS tool_name,
            LEFT(COALESCE(request_id, ''), 220) AS detail,
            ROUND(COALESCE(total_cost_usd, 0), 6) AS cost,
            COALESCE(total_tokens, 0) AS total_tokens,
            COALESCE(status, '') AS status
        FROM model_calls
        WHERE session_id = '${escaped_session_id}'

        UNION ALL

        SELECT
            call_ts AS event_ts,
            'tool_call' AS event_type,
            '' AS role,
            '' AS model,
            COALESCE(tool_name, '') AS tool_name,
            LEFT(COALESCE(arguments_text, ''), 220) AS detail,
            0.0 AS cost,
            0 AS total_tokens,
            COALESCE(status, '') AS status
        FROM tool_calls
        WHERE session_id = '${escaped_session_id}'

        ORDER BY event_ts;
        "
        return
    fi

    query_session_timeline "${session_id}"
}

query_compare_versions_fast() {
    local agent_name="$1"
    local escaped_agent_name
    escaped_agent_name="$(escape_sql_literal "${agent_name}")"

    if has_indexed_db; then
        echo "📊 Compare Versions: ${agent_name}"
        echo "===================================="
        run_duckdb_sql "
        SELECT
            agent_version AS version,
            COUNT(DISTINCT session_id) AS sessions,
            ROUND(AVG(session_cost), 4) AS avg_cost_per_session,
            ROUND(AVG(session_tokens), 0) AS avg_tokens_per_session,
            ROUND(AVG(session_latency), 0) AS avg_latency_ms,
            ROUND(AVG(requests_per_session), 1) AS avg_llm_calls
        FROM (
            SELECT
                agent_version,
                session_id,
                SUM(COALESCE(total_cost_usd, 0)) AS session_cost,
                SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) AS session_tokens,
                SUM(COALESCE(duration_ms, 0)) AS session_latency,
                COUNT(*) AS requests_per_session
            FROM model_calls
            WHERE agent_id = '${escaped_agent_name}'
            GROUP BY agent_version, session_id
        )
        GROUP BY agent_version
        ORDER BY agent_version DESC;
        "
        return
    fi

    query_compare_versions "${agent_name}"
}

query_top_sessions_fast() {
    local agent_name="$1"
    local since_ms="${2:-86400000}"
    local escaped_agent_name
    escaped_agent_name="$(escape_sql_literal "${agent_name}")"

    if has_indexed_db; then
        echo "📊 Top Sessions: ${agent_name}"
        echo "==============================="
        run_duckdb_sql "
        WITH recent AS (
            SELECT *
            FROM model_calls
            WHERE agent_id = '${escaped_agent_name}'
              AND start_ms > (EXTRACT(EPOCH FROM NOW()) * 1000 - ${since_ms})
        ),
        target AS (
            SELECT * FROM recent
            UNION ALL
            SELECT *
            FROM model_calls
            WHERE agent_id = '${escaped_agent_name}'
              AND NOT EXISTS (SELECT 1 FROM recent)
        )
        SELECT
            session_id,
            ROUND(SUM(COALESCE(total_cost_usd, 0)), 6) AS total_cost,
            SUM(COALESCE(prompt_tokens, 0)) AS input_tokens,
            SUM(COALESCE(completion_tokens, 0)) AS output_tokens,
            COUNT(*) AS llm_calls,
            COUNT(DISTINCT request_id) AS requests,
            ROUND(AVG(COALESCE(duration_ms, 0)), 0) AS avg_latency_ms,
            MIN(to_timestamp(start_ms / 1000.0)) AS started_at
        FROM target
        GROUP BY session_id
        ORDER BY total_cost DESC
        LIMIT 10;
        "
        return
    fi

    query_top_sessions "${agent_name}" "${since_ms}"
}

query_agent_kpis_daily() {
    if has_indexed_db; then
        echo "📊 Agent KPIs Daily"
        run_duckdb_sql "
        SELECT *
        FROM agent_kpis_daily
        ORDER BY day DESC, total_cost_usd DESC
        LIMIT 50;
        "
        return
    fi

    echo "Indexed analytics DB not found; daily KPI view unavailable without index DB."
    exit 1
}

query_training_examples() {
    echo "training_examples view has been retired in this refactor."
    echo "Use --session-last for message snapshots and --session-timeline for model/tool event chronology."
    exit 1
}

query_recent_messages() {
    local limit="${1:-20}"
    if ! [[ "${limit}" =~ ^[0-9]+$ ]]; then
        echo "Limit must be numeric"
        exit 1
    fi

    if has_indexed_db; then
        echo "📊 Recent Sessions (message snapshot source)"
        echo "==========================================="
        run_duckdb_sql "
        SELECT
            session_id,
            to_timestamp(MAX(start_ms) / 1000.0) AS latest_call_ts,
            COUNT(*) AS model_calls,
            ROUND(SUM(COALESCE(total_cost_usd, 0)), 6) AS total_cost,
            SUM(COALESCE(total_tokens, 0)) AS total_tokens
        FROM model_calls
        GROUP BY session_id
        ORDER BY latest_call_ts DESC
        LIMIT ${limit};
        "
        return
    fi

    echo "Indexed analytics DB not found; recent session query unavailable without index DB."
    exit 1
}

query_last_session_messages() {
    local limit="${1:-8}"
    if ! [[ "${limit}" =~ ^[0-9]+$ ]]; then
        echo "Limit must be numeric"
        exit 1
    fi

    if has_indexed_db; then
        local latest_session
        latest_session="$(${DUCKDB} -readonly "${INDEX_DB_PATH}" -csv -c "
            SELECT session_id
            FROM sessions
            ORDER BY ended_at DESC NULLS LAST, started_at DESC NULLS LAST
            LIMIT 1;
        " | tail -n 1)"

        if [[ -z "${latest_session}" ]]; then
            echo "No sessions found in indexed DB."
            exit 0
        fi

        query_session_last_messages "${latest_session}" "${limit}"
        return
    fi

    local latest_session
    latest_session="$(${DUCKDB} -csv -c "
        ${BASE_QUERY},
        extracted AS (${EXTRACT_ATTRS})
        SELECT session_id
        FROM extracted
        WHERE session_id IS NOT NULL
        ORDER BY start_ms DESC
        LIMIT 1;
    " | tail -n 1)"
    if [[ -z "${latest_session}" ]]; then
        echo "No sessions found in traces."
        exit 0
    fi
    query_session_messages "${latest_session}" "${limit}"
}

query_session_debug() {
    local session_id="$1"
    local escaped_session_id
    escaped_session_id="$(escape_sql_literal "${session_id}")"

    echo "📊 Session Debug: ${session_id}"
    echo "=============================="

    if has_indexed_db; then
        echo ""
        echo "Summary"
        echo "-------"
        run_duckdb_sql "
        SELECT
            session_id,
            COALESCE(agent_id, '') AS agent_id,
            COALESCE(agent_version, '') AS agent_version,
            COALESCE(engine, '') AS engine,
            COALESCE(status, '') AS status,
            started_at,
            ended_at,
            total_turns,
            total_requests,
            ROUND(COALESCE(total_cost_usd, 0), 6) AS total_cost_usd,
            COALESCE(total_tokens, 0) AS total_tokens
        FROM sessions
        WHERE session_id = '${escaped_session_id}'
        LIMIT 1;
        "

        echo ""
        echo "Recent Requests"
        echo "---------------"
        run_duckdb_sql "
        SELECT
            COALESCE(request_id, '') AS request_id,
            COUNT(*) AS llm_calls,
            ROUND(SUM(COALESCE(total_cost_usd, 0)), 6) AS total_cost_usd,
            SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) AS total_tokens,
            SUM(CASE WHEN lower(COALESCE(status, '')) IN ('error', 'failed', 'failure') THEN 1 ELSE 0 END) AS error_calls,
            MAX(to_timestamp(start_ms / 1000.0)) AS latest_call_ts
        FROM model_calls
        WHERE session_id = '${escaped_session_id}'
        GROUP BY request_id
        ORDER BY latest_call_ts DESC
        LIMIT ${SESSION_DEBUG_REQUEST_LIMIT};
        "

        if has_indexed_table "tool_calls"; then
            echo ""
            echo "Tool Signals"
            echo "------------"
            run_duckdb_sql "
            SELECT
                COALESCE(request_id, '') AS request_id,
                COALESCE(tool_name, '') AS tool_name,
                COUNT(*) AS calls,
                SUM(CASE WHEN lower(COALESCE(status, '')) IN ('error', 'failed', 'failure') THEN 1 ELSE 0 END) AS error_calls,
                ROUND(AVG(COALESCE(duration_ms, 0)), 2) AS avg_duration_ms,
                MAX(call_ts) AS latest_call_ts
            FROM tool_calls
            WHERE session_id = '${escaped_session_id}'
            GROUP BY request_id, tool_name
            ORDER BY error_calls DESC, calls DESC, latest_call_ts DESC
            LIMIT ${SESSION_DEBUG_TOOL_LIMIT};
            "
        fi

        echo ""
        query_session_last_messages "${session_id}" 4
        echo ""
        echo "Next"
        echo "----"
        echo "Use --request <request-id> for one request, --session-tools ${session_id} for tool details, or --session-timeline ${session_id} for chronology."
        return
    fi

    echo ""
    echo "Indexed analytics DB not found; using trace/session-file fallback."
    echo ""
    query_session "${session_id}"
    echo ""
    if [[ -f "${SESSIONS_DIR}/${session_id}.jsonl" ]]; then
        query_tool_loops "${session_id}"
        echo ""
    fi
    query_session_messages "${session_id}" 4
    echo ""
    echo "Next"
    echo "----"
    echo "Use --session ${session_id} for all LLM calls or --session-timeline ${session_id} for chronology."
}

# Base query to parse OTEL JSONL format
# Note: OTEL Collector file exporter writes one JSON object per line
BASE_QUERY="
WITH raw_spans AS (
    SELECT
        unnest(resourceSpans) as rs
    FROM read_json('${TRACES_DIR}/*.jsonl',
                   format='newline_delimited',
                   ignore_errors=true)
),
spans AS (
    SELECT
        unnest(rs.scopeSpans) as ss
    FROM raw_spans
),
flat_spans AS (
    SELECT
        unnest(ss.spans) as span
    FROM spans
),
parsed AS (
    SELECT
        span.traceId as trace_id,
        span.spanId as span_id,
        span.name as span_name,
        span.startTimeUnixNano::BIGINT / 1000000 as start_ms,
        span.endTimeUnixNano::BIGINT / 1000000 as end_ms,
        (span.endTimeUnixNano::BIGINT - span.startTimeUnixNano::BIGINT) / 1000000 as duration_ms,
        json_extract(to_json(span), '$.attributes') as attrs_json
    FROM flat_spans
),
span_filter AS (
    SELECT
        trace_id,
        span_name,
        duration_ms,
        start_ms,
        attrs_json
    FROM parsed
    WHERE span_name = 'Received Proxy Server Request'
       OR EXISTS (
           SELECT 1
           FROM json_each(coalesce(attrs_json, '[]'::JSON)) as attr
           WHERE json_extract_string(attr.value, '$.key') = 'gen_ai.cost.total_cost'
       )
),
attrs AS (
    SELECT
        trace_id,
        span_name,
        duration_ms,
        start_ms,
        json_extract_string(value, '$.key') as attr_key,
        json_extract_string(value, '$.value.stringValue') as attr_string,
        json_extract_string(value, '$.value.intValue') as attr_int,
        json_extract(value, '$.value.doubleValue') as attr_double
    FROM span_filter,
         json_each(coalesce(attrs_json, '[]'::JSON))
)
"

# Extract LLM attributes from OTEL span attributes
# OTEL attributes are stored as array of {key, value} objects
# Canonical metadata source: metadata.requester_custom_headers (x-litellm-metadata-*)
# Enriched with: session_id, user_id, project_id, agent_id, agent_version, source, engine, request_id
EXTRACT_ATTRS="
WITH span_rows AS (
    SELECT
        trace_id,
        span_name,
        duration_ms,
        start_ms,
        NULLIF(regexp_extract(
            max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
            'x-litellm-metadata-session-id'': ''([^'']+)''', 1
        ), '') as session_id,
        NULLIF(regexp_extract(
            max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
            'x-litellm-metadata-user-id'': ''([^'']+)''', 1
        ), '') as user_id,
        NULLIF(regexp_extract(
            max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
            'x-litellm-metadata-project-id'': ''([^'']+)''', 1
        ), '') as project_id,
        max(CASE WHEN attr_key IN ('gen_ai.request.model', 'gen_ai.response.model', 'model') THEN attr_string END) as model,
        max(CASE WHEN attr_key = 'gen_ai.cost.total_cost' THEN CAST(attr_double AS DOUBLE) END) as cost,
        max(CASE WHEN attr_key = 'gen_ai.usage.input_tokens' THEN CAST(attr_int AS BIGINT) END) as input_tokens,
        max(CASE WHEN attr_key = 'gen_ai.usage.output_tokens' THEN CAST(attr_int AS BIGINT) END) as output_tokens,
        NULLIF(regexp_extract(
            max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
            'x-litellm-metadata-agent-id'': ''([^'']+)''', 1
        ), '') as agent_id,
        NULLIF(regexp_extract(
            max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
            'x-litellm-metadata-agent-version'': ''([^'']+)''', 1
        ), '') as agent_version,
        NULLIF(regexp_extract(
            max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
            'x-litellm-metadata-source'': ''([^'']+)''', 1
        ), '') as source,
        NULLIF(regexp_extract(
            max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
            'x-litellm-metadata-engine'': ''([^'']+)''', 1
        ), '') as engine,
        NULLIF(regexp_extract(
            max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
            'x-litellm-metadata-request-id'': ''([^'']+)''', 1
        ), '') as request_id
    FROM attrs
    GROUP BY trace_id, span_name, duration_ms, start_ms
),
deduped AS (
    SELECT DISTINCT ON (trace_id)
        trace_id,
        span_name,
        duration_ms,
        start_ms,
        session_id,
        user_id,
        project_id,
        model,
        cost,
        input_tokens,
        output_tokens,
        agent_id,
        agent_version,
        source,
        engine,
        request_id
    FROM span_rows
    ORDER BY
        trace_id,
        COALESCE(cost, 0) DESC,
        CASE
            WHEN span_name = 'raw_gen_ai_request' THEN 0
            WHEN span_name = 'litellm_request' THEN 1
            ELSE 2
        END,
        start_ms DESC
)
SELECT * FROM deduped
"

# ============================================================================
# Query functions
# ============================================================================

query_total_cost() {
    check_traces
    echo "📊 Total Cost Summary"
    echo "===================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(SUM(cost), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COUNT(*) as total_requests,
        ROUND(AVG(duration_ms), 0) as avg_latency_ms
    FROM extracted;
    "
}

query_cost_by_session() {
    check_traces
    echo "📊 Cost by Session"
    echo "=================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(session_id, '(no session)') as session_id,
        ROUND(COALESCE(SUM(cost), 0), 6) as total_cost,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as requests,
        ROUND(AVG(duration_ms), 0) as avg_latency_ms
    FROM extracted
    GROUP BY session_id
    ORDER BY total_cost DESC
    LIMIT 20;
    "
}

query_cost_by_model() {
    check_traces
    echo "📊 Cost by Model"
    echo "================"
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(model, '(unknown)') as model,
        ROUND(COALESCE(SUM(cost), 0), 6) as total_cost,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as requests,
        ROUND(AVG(duration_ms), 0) as avg_latency_ms
    FROM extracted
    GROUP BY model
    ORDER BY total_cost DESC;
    "
}

query_cost_by_pack() {
    check_traces
    echo "📊 Cost by Agent"
    echo "================"
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(agent_id, '(no agent)') as agent,
        COALESCE(agent_version, '?') as version,
        ROUND(COALESCE(SUM(cost), 0), 6) as total_cost,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as requests
    FROM extracted
    GROUP BY agent_id, agent_version
    ORDER BY total_cost DESC;
    "
}

query_cost_by_engine() {
    check_traces
    echo "📊 Cost by Engine"
    echo "================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(engine, '(unknown)') as engine,
        model,
        ROUND(SUM(cost), 6) as total_cost,
        COUNT(*) as requests,
        ROUND(AVG(duration_ms), 0) as avg_latency_ms
    FROM extracted
    GROUP BY engine, model
    ORDER BY total_cost DESC;
    "
}

query_cost_by_source() {
    check_traces
    echo "📊 Cost by Source Framework"
    echo "=========================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(source, '(unknown)') as framework,
        ROUND(SUM(cost), 6) as total_cost,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(*) as requests,
        ROUND(AVG(cost), 6) as avg_cost_per_request
    FROM extracted
    GROUP BY source
    ORDER BY total_cost DESC;
    "
}

query_cost_per_request() {
    local session_id="${1:-}"
    check_traces
    echo "📊 Cost per Request"
    echo "==================="
    local where_clause=""
    if [[ -n "${session_id}" ]]; then
        where_clause="WHERE session_id = '${session_id}' AND request_id IS NOT NULL"
        echo "   Session: ${session_id}"
    else
        where_clause="WHERE request_id IS NOT NULL"
    fi
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        request_id,
        COUNT(*) as llm_calls,
        ROUND(COALESCE(SUM(cost), 0), 6) as request_cost,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        ROUND(COALESCE(SUM(duration_ms), 0), 0) as total_latency_ms,
        MIN(to_timestamp(start_ms / 1000)) as started_at
    FROM extracted
    ${where_clause}
    GROUP BY request_id
    ORDER BY MIN(start_ms);
    "
}

query_session() {
    local session_id="$1"
    check_traces
    echo "📊 Session: ${session_id}"
    echo "========================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        model,
        ROUND(cost, 6) as cost,
        input_tokens,
        output_tokens,
        duration_ms as latency_ms,
        COALESCE(request_id, '') as request_id,
        to_timestamp(start_ms / 1000) as timestamp
    FROM extracted
    WHERE session_id = '${session_id}'
    ORDER BY start_ms;
    "
}

query_request() {
    local request_id="$1"
    check_traces
    echo "📊 Request: ${request_id}"
    echo "========================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        model,
        ROUND(cost, 6) as cost,
        input_tokens,
        output_tokens,
        duration_ms as latency_ms,
        to_timestamp(start_ms / 1000) as timestamp
    FROM extracted
    WHERE request_id = '${request_id}'
    ORDER BY start_ms;
    "
}

query_session_messages() {
    local session_id="$1"
    local limit="${2:-${TRACE_EVENT_PREVIEW_LIMIT}}"
    local artifact_path
    check_traces
    if ! [[ "${limit}" =~ ^[0-9]+$ ]]; then
        echo "Limit must be numeric"
        exit 1
    fi
    artifact_path="$(make_artifact_path "session-trace-$(sanitize_artifact_label "${session_id}")" "txt")"
    echo "📊 Session Messages (trace parse, safe preview): ${session_id}"
    echo "================================================"
    python3 - "${TRACES_DIR}" "${session_id}" "${limit}" "${MESSAGE_PREVIEW_CHARS}" "${MESSAGE_OUTPUT_BUDGET_CHARS}" "${artifact_path}" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import sys
import textwrap
from datetime import datetime, timezone

traces_dir = pathlib.Path(sys.argv[1])
target_session = sys.argv[2]
limit = max(1, int(sys.argv[3]))
preview_chars = max(80, int(sys.argv[4]))
output_budget = max(1000, int(sys.argv[5]))
artifact_path = sys.argv[6]

session_patterns = [
    re.compile(r"x-litellm-metadata-session-id'?:\s*'([^']+)'"),
    re.compile(r'"x-litellm-metadata-session-id"\s*:\s*"([^"]+)"'),
]
request_patterns = [
    re.compile(r"x-litellm-metadata-request-id'?:\s*'([^']+)'"),
    re.compile(r'"x-litellm-metadata-request-id"\s*:\s*"([^"]+)"'),
]

input_keys = {
    "gen_ai.input.messages",
    "llm.None.messages",
    "llm.openai.messages",
    "llm.anthropic.messages",
}
output_keys = {
    "gen_ai.output.messages",
    "llm.openai.choices",
    "llm.anthropic.completion",
}


def attr_string_value(attr):
    value = (attr or {}).get("value", {})
    if "stringValue" in value:
        return value.get("stringValue")
    if "intValue" in value:
        return str(value.get("intValue"))
    if "doubleValue" in value:
        return str(value.get("doubleValue"))
    if "boolValue" in value:
        return "true" if value.get("boolValue") else "false"
    return ""


def extract_header_value(raw, patterns):
    if not isinstance(raw, str):
        return ""
    for pattern in patterns:
        match = pattern.search(raw)
        if match:
            return match.group(1)
    return ""


def extract_text_parts(msg):
    if isinstance(msg, str):
        return [msg]
    if not isinstance(msg, dict):
        return [str(msg)]

    if "message" in msg:
        return extract_text_parts(msg["message"])

    if "choices" in msg and isinstance(msg["choices"], list):
        collected = []
        for choice in msg["choices"]:
            collected.extend(extract_text_parts(choice))
        return collected

    for key in ("parts", "content"):
        value = msg.get(key)
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            collected = []
            for item in value:
                if isinstance(item, dict):
                    item_type = item.get("type", "")
                    if item_type in ("thinking", "signature", "tool_result"):
                        continue
                    text = item.get("text", item.get("content", ""))
                    if text:
                        collected.append(str(text))
                        continue
                    collected.extend(extract_text_parts(item))
                elif isinstance(item, str):
                    collected.append(item)
            if collected:
                return collected

    text = msg.get("text")
    if isinstance(text, str) and text:
        return [text]

    content = msg.get("content")
    if isinstance(content, str) and content:
        return [content]

    return [str(msg)]


def build_part_tail_preview(parts):
    source_parts = [str(part) for part in parts if str(part)]
    if not source_parts:
        return "", "", 0, 0
    part_preview_chars = max(80, min(400, preview_chars))
    preview_parts = []
    truncated_part_count = 0
    for part in source_parts:
        if len(part) > part_preview_chars:
            preview_parts.append("..." + part[-part_preview_chars:])
            truncated_part_count += 1
        else:
            preview_parts.append(part)
    return "\n".join(source_parts), "\n...\n".join(preview_parts), len(source_parts), truncated_part_count


def format_text(content, indent=4, width=100):
    if content is None:
        content = ""
    content = str(content)
    prefix = " " * indent
    return textwrap.fill(content, width=width, initial_indent=prefix, subsequent_indent=prefix)


def iter_payload_messages(payload, kind):
    try:
        parsed = json.loads(payload)
    except Exception:
        parsed = None

    if isinstance(parsed, list):
        for item in parsed:
            yield item
        return
    if isinstance(parsed, dict) and isinstance(parsed.get("choices"), list):
        for item in parsed["choices"]:
            yield item
        return
    if parsed is not None:
        yield parsed
        return
    yield payload


messages = []
seen_payloads = set()
message_seq = 0
for file_path in sorted(traces_dir.glob("*.jsonl")):
    try:
        with file_path.open("r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    root = json.loads(line)
                except Exception:
                    continue

                for resource_span in root.get("resourceSpans", []) or []:
                    for scope_span in resource_span.get("scopeSpans", []) or []:
                        for span in scope_span.get("spans", []) or []:
                            attrs = span.get("attributes", []) or []
                            headers = ""
                            model = ""
                            input_payloads = []
                            output_payloads = []

                            for attr in attrs:
                                key = attr.get("key")
                                value = attr_string_value(attr)
                                if key == "metadata.requester_custom_headers" and isinstance(value, str):
                                    headers = value
                                elif key in ("gen_ai.request.model", "gen_ai.response.model", "model") and value:
                                    model = str(value)
                                elif key in input_keys and value:
                                    input_payloads.append(str(value))
                                elif key in output_keys and value:
                                    output_payloads.append(str(value))

                            session_id = extract_header_value(headers, session_patterns)
                            if session_id != target_session:
                                continue

                            request_id = extract_header_value(headers, request_patterns)
                            try:
                                start_ns = int(span.get("startTimeUnixNano") or 0)
                            except Exception:
                                start_ns = 0

                            trace_id = span.get("traceId", "")
                            timestamp = datetime.fromtimestamp(start_ns / 1_000_000_000, tz=timezone.utc).isoformat() if start_ns else "(unknown)"
                            for kind, payloads in (("input", input_payloads), ("output", output_payloads)):
                                for payload in payloads:
                                    digest = hashlib.sha1(payload.encode("utf-8", errors="ignore")).hexdigest()
                                    request_key = request_id or trace_id
                                    dedupe_key = (kind, request_key, digest)
                                    if dedupe_key in seen_payloads:
                                        continue
                                    seen_payloads.add(dedupe_key)
                                    for raw_message in iter_payload_messages(payload, kind):
                                        role = "assistant" if kind == "output" else "user"
                                        if isinstance(raw_message, dict):
                                            role = str(
                                                raw_message.get("role")
                                                or raw_message.get("message", {}).get("role")
                                                or role
                                            ).lower()
                                        content_parts = extract_text_parts(raw_message)
                                        content, preview, preview_part_count, truncated_part_count = build_part_tail_preview(content_parts)
                                        if role not in ("user", "assistant") or not content:
                                            continue
                                        message_seq += 1
                                        messages.append(
                                            {
                                                "role": role,
                                                "ts": timestamp,
                                                "request_id": request_id,
                                                "model": model or "(unknown)",
                                                "start_ns": start_ns,
                                                "seq": message_seq,
                                                "content_text": content,
                                                "content_preview": preview,
                                                "content_chars": len(content),
                                                "is_truncated": truncated_part_count > 0,
                                                "preview_part_count": preview_part_count,
                                                "truncated_part_count": truncated_part_count,
                                            }
                                        )
    except Exception:
        continue

if not messages:
    print("(no trace messages found for this session)")
    raise SystemExit(0)

messages.sort(key=lambda row: (row["start_ns"], row["seq"]))
selected = messages[-limit:]

def render_row(row, index, full=False):
    header = (
        f"\n[{index}] {row['ts']} | {row['role'].upper()} | model={row['model']}"
        + (f" | request_id={row['request_id']}" if row["request_id"] else "")
    )
    body = format_text(row["content_text"] if full else row["content_preview"])
    suffix = ""
    if row["is_truncated"] and not full:
        if row.get("preview_part_count", 1) > 1:
            suffix = (
                f"\n    [per-part tail preview: {row['preview_part_count']} parts, "
                f"{row.get('truncated_part_count', 0)} truncated, {row['content_chars']} chars total]"
            )
        else:
            visible_chars = len(row["content_preview"]) - 3 if row["content_preview"].startswith("...") else len(row["content_preview"])
            suffix = f"\n    [tail preview truncated: showing last {visible_chars} of {row['content_chars']} chars]"
    return f"{header}\n{body}{suffix}"

rendered_selected = [render_row(row, idx) for idx, row in enumerate(selected, start=1)]
artifact_needed = (
    len(messages) > len(selected)
    or any(row["is_truncated"] for row in messages)
)
if artifact_needed:
    with open(artifact_path, "w", encoding="utf-8") as handle:
        handle.write("Spotlight Query trace message artifact\n")
        handle.write(f"messages={len(messages)} selected={len(selected)}\n")
        for idx, row in enumerate(messages, start=1):
            handle.write(render_row(row, idx, full=True))
            handle.write("\n")

printed = 0
consumed = 0
for block in rendered_selected:
    projected = consumed + len(block)
    if printed > 0 and projected > output_budget:
        break
    print(block)
    consumed = projected
    printed += 1

omitted_from_selection = len(rendered_selected) - printed
if len(messages) > len(selected):
    print(f"\nShowing last {len(selected)} of {len(messages)} extracted user/assistant messages.")
if omitted_from_selection > 0:
    print(f"Output clipped after {printed} rows to stay within {output_budget} chars.")
if artifact_needed:
    print(f"Artifact: {artifact_path}")
PY
}

query_compare_versions() {
    local agent_name="$1"
    check_traces
    echo "📊 Compare Versions: ${agent_name}"
    echo "===================================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        agent_version as version,
        COUNT(DISTINCT session_id) as sessions,
        ROUND(AVG(session_cost), 4) as avg_cost_per_session,
        ROUND(AVG(session_tokens), 0) as avg_tokens_per_session,
        ROUND(AVG(session_latency), 0) as avg_latency_ms,
        ROUND(AVG(requests_per_session), 1) as avg_llm_calls
    FROM (
        SELECT
            agent_version,
            session_id,
            SUM(cost) as session_cost,
            SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as session_tokens,
            SUM(duration_ms) as session_latency,
            COUNT(*) as requests_per_session
        FROM extracted
        WHERE agent_id = '${agent_name}'
        GROUP BY agent_version, session_id
    )
    GROUP BY agent_version
    ORDER BY agent_version DESC;
    "
}

query_top_sessions() {
    local agent_name="$1"
    local since_ms="${2:-86400000}"  # default: 24h in ms
    check_traces
    echo "📊 Top Sessions: ${agent_name}"
    echo "==============================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        session_id,
        ROUND(SUM(cost), 6) as total_cost,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as llm_calls,
        COUNT(DISTINCT request_id) as requests,
        ROUND(AVG(duration_ms), 0) as avg_latency_ms,
        MIN(to_timestamp(start_ms / 1000)) as started_at
    FROM extracted
    WHERE agent_id = '${agent_name}'
      AND start_ms > (EXTRACT(EPOCH FROM NOW()) * 1000 - ${since_ms})
    GROUP BY session_id
    ORDER BY total_cost DESC
    LIMIT 10;
    "
}

query_latency_percentiles() {
    check_traces
    echo "📊 Latency Percentiles (by model and agent)"
    echo "============================================"
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(agent_id, '(default)') as agent,
        model,
        COUNT(*) as requests,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms), 0) as p50_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms), 0) as p95_ms,
        ROUND(AVG(duration_ms), 0) as avg_ms,
        MAX(duration_ms) as max_ms
    FROM extracted
    GROUP BY agent_id, model
    ORDER BY p95_ms DESC;
    "
}

query_errors() {
    check_traces
    echo "📊 Error Rate by Model"
    echo "======================"
    echo "(Note: error detection depends on LiteLLM OTEL span attributes)"
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS}),
    error_traces AS (
        SELECT DISTINCT trace_id
        FROM attrs
        WHERE attr_key IN ('exception.type', 'exception.message')
           OR (attr_key = 'otel.status_code' AND attr_string = 'ERROR')
           OR (attr_key = 'http.status_code' AND CAST(attr_int AS INT) >= 400)
    )
    SELECT
        COALESCE(e.model, '(unknown)') as model,
        COUNT(*) as total_requests,
        COUNT(er.trace_id) as errors,
        ROUND(COUNT(er.trace_id)::FLOAT / COUNT(*) * 100, 1) as error_rate_pct
    FROM extracted e
    LEFT JOIN error_traces er ON e.trace_id = er.trace_id
    GROUP BY e.model
    ORDER BY error_rate_pct DESC;
    "
}

query_largest_requests() {
    local limit="${1:-20}"
    check_traces
    echo "📊 Largest Requests by Input Tokens"
    echo "===================================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(session_id, '') as session_id,
        COALESCE(request_id, '') as request_id,
        COALESCE(agent_id, '') as agent,
        model,
        input_tokens,
        output_tokens,
        ROUND(cost, 6) as cost,
        duration_ms as latency_ms,
        to_timestamp(start_ms / 1000) as timestamp
    FROM extracted
    WHERE input_tokens IS NOT NULL
    ORDER BY input_tokens DESC
    LIMIT ${limit};
    "
}

query_problems() {
    check_traces
    echo "📊 Problem Sessions (statistical outliers)"
    echo "==========================================="
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS}),
    session_summary AS (
        SELECT
            session_id,
            COALESCE(agent_id, '(default)') as agent_id,
            ROUND(SUM(cost), 6) as total_cost,
            SUM(COALESCE(input_tokens, 0)) as total_input_tokens,
            COUNT(*) as llm_calls,
            COUNT(DISTINCT request_id) as requests,
            MAX(duration_ms) as max_latency_ms,
            MIN(to_timestamp(start_ms / 1000)) as started_at
        FROM extracted
        GROUP BY session_id, agent_id
    ),
    overall_stats AS (
        SELECT
            AVG(total_cost) as avg_cost,
            STDDEV(total_cost) as stddev_cost,
            AVG(total_input_tokens) as avg_tokens,
            STDDEV(total_input_tokens) as stddev_tokens
        FROM session_summary
        WHERE total_cost > 0
    )
    SELECT
        s.session_id,
        s.agent_id as agent,
        s.total_cost,
        s.total_input_tokens as input_tokens,
        s.llm_calls,
        s.requests,
        s.max_latency_ms,
        CASE
            WHEN o.stddev_cost > 0 AND s.total_cost > o.avg_cost + 2 * o.stddev_cost THEN 'COST OUTLIER'
            WHEN o.stddev_tokens > 0 AND s.total_input_tokens > o.avg_tokens + 2 * o.stddev_tokens THEN 'TOKEN OUTLIER'
            WHEN s.requests > 0 AND s.llm_calls > s.requests * 5 THEN 'EXCESSIVE LLM CALLS'
            WHEN s.max_latency_ms > 30000 THEN 'HIGH LATENCY'
            ELSE '?'
        END as problem_type,
        s.started_at
    FROM session_summary s, overall_stats o
    WHERE (o.stddev_cost > 0 AND s.total_cost > o.avg_cost + 2 * o.stddev_cost)
       OR (o.stddev_tokens > 0 AND s.total_input_tokens > o.avg_tokens + 2 * o.stddev_tokens)
       OR (s.requests > 0 AND s.llm_calls > s.requests * 5)
       OR s.max_latency_ms > 30000
    ORDER BY s.total_cost DESC
    LIMIT 20;
    "
}

# ============================================================================
# Tier 2: Session Event Queries (require Layer 2 session events)
# Session events live in ${ANALYTICS_DIR}/sessions/<session_id>.jsonl
# ============================================================================
SESSIONS_DIR="${ANALYTICS_DIR}/sessions"

check_sessions() {
    if ! ls "${SESSIONS_DIR}"/*.jsonl &> /dev/null; then
        echo "No session event files found in ${SESSIONS_DIR}/"
        echo "Session events are captured when running agents with observability enabled."
        exit 0
    fi
}

query_tool_loops() {
    local session_id="$1"
    check_sessions
    echo "📊 Tool Loop Detection: ${session_id}"
    echo "======================================"
    ${DUCKDB} -c "
    WITH tool_events AS (
        SELECT
            session_id,
            request_id,
            json_extract_string(to_json(payload), '$.toolName') as tool_name,
            json_extract_string(to_json(payload), '$.callId') as call_id,
            timestamp
        FROM read_json(
            '${SESSIONS_DIR}/${session_id}.jsonl',
            format='newline_delimited',
            ignore_errors=true
        )
        WHERE event_type = 'tool_start'
    ),
    tool_counts AS (
        SELECT
            request_id,
            tool_name,
            COUNT(*) as call_count,
            MIN(timestamp) as first_call,
            MAX(timestamp) as last_call
        FROM tool_events
        GROUP BY request_id, tool_name
    )
    SELECT
        COALESCE(request_id, '(unknown)') as request_id,
        tool_name,
        call_count,
        CASE WHEN call_count > 5 THEN 'POSSIBLE LOOP' ELSE 'ok' END as status,
        ROUND((last_call - first_call) / 1000.0, 1) as span_seconds
    FROM tool_counts
    ORDER BY call_count DESC;
    "
}

query_tool_stats() {
    local session_filter="${1:-}"
    check_sessions
    echo "📊 Tool Usage Statistics"
    echo "========================"
    local glob_pattern
    if [[ -n "${session_filter}" ]]; then
        glob_pattern="${SESSIONS_DIR}/${session_filter}.jsonl"
        echo "   Session: ${session_filter}"
    else
        glob_pattern="${SESSIONS_DIR}/*.jsonl"
    fi
    ${DUCKDB} -c "
    WITH starts AS (
        SELECT
            session_id,
            request_id,
            json_extract_string(to_json(payload), '$.toolName') as tool_name,
            json_extract_string(to_json(payload), '$.callId') as call_id,
            timestamp as start_ts
        FROM read_json('${glob_pattern}',
                       format='newline_delimited', ignore_errors=true)
        WHERE event_type = 'tool_start'
          AND json_extract_string(to_json(payload), '$.callId') IS NOT NULL
          AND json_extract_string(to_json(payload), '$.callId') != ''
    ),
    ends AS (
        SELECT
            session_id,
            request_id,
            json_extract_string(to_json(payload), '$.toolName') as tool_name,
            json_extract_string(to_json(payload), '$.callId') as call_id,
            timestamp as end_ts,
            CASE WHEN json_extract_string(to_json(payload), '$.isError') = 'true' THEN 1 ELSE 0 END as is_error
        FROM read_json('${glob_pattern}',
                       format='newline_delimited', ignore_errors=true)
        WHERE event_type = 'tool_end'
          AND json_extract_string(to_json(payload), '$.callId') IS NOT NULL
          AND json_extract_string(to_json(payload), '$.callId') != ''
    ),
    tool_pairs AS (
        SELECT
            s.tool_name,
            (e.end_ts - s.start_ts) as duration_ms,
            e.is_error
        FROM starts s
        JOIN ends e ON s.call_id = e.call_id AND s.session_id = e.session_id AND s.request_id = e.request_id
    )
    SELECT
        tool_name,
        COUNT(*) as total_calls,
        ROUND(AVG(duration_ms), 0) as avg_duration_ms,
        ROUND(SUM(is_error)::FLOAT / COUNT(*) * 100, 1) as error_rate_pct,
        MAX(duration_ms) as max_duration_ms
    FROM tool_pairs
    GROUP BY tool_name
    ORDER BY total_calls DESC;
    "
}

query_session_timeline() {
    local session_id="$1"
    check_traces
    echo "📊 Session Timeline: ${session_id}"
    echo "==================================="
    echo "(unified LLM calls + tool events)"
    # Check if session events exist for this session
    local has_events=false
    if [[ -f "${SESSIONS_DIR}/${session_id}.jsonl" ]]; then
        has_events=true
    fi

    if [[ "${has_events}" == "true" ]]; then
        ${DUCKDB} -c "
        ${BASE_QUERY},
        extracted AS (${EXTRACT_ATTRS}),
        llm_events AS (
            SELECT
                start_ms as timestamp,
                'llm_call' as event_type,
                model as detail,
                ROUND(cost, 6) as cost,
                input_tokens,
                output_tokens,
                duration_ms
            FROM extracted
            WHERE session_id = '${session_id}'
        ),
        agent_events AS (
            SELECT
                timestamp,
                event_type,
                COALESCE(
                    json_extract_string(to_json(payload), '$.toolName'),
                    event_type
                ) as detail,
                NULL::DOUBLE as cost,
                NULL::BIGINT as input_tokens,
                NULL::BIGINT as output_tokens,
                NULL::BIGINT as duration_ms
            FROM read_json(
                '${SESSIONS_DIR}/${session_id}.jsonl',
                format='newline_delimited',
                ignore_errors=true
            )
        )
        SELECT * FROM (
            SELECT * FROM llm_events
            UNION ALL
            SELECT * FROM agent_events
        )
        ORDER BY timestamp;
        "
    else
        # No session events — just show LLM calls
        ${DUCKDB} -c "
        ${BASE_QUERY},
        extracted AS (${EXTRACT_ATTRS})
        SELECT
            start_ms as timestamp,
            'llm_call' as event_type,
            model as detail,
            ROUND(cost, 6) as cost,
            input_tokens,
            output_tokens,
            duration_ms
        FROM extracted
        WHERE session_id = '${session_id}'
        ORDER BY start_ms;
        "
    fi
}

query_latest_session() {
    check_traces
    echo "📊 Latest Session"
    echo "================"
    ${DUCKDB} -c "
    ${BASE_QUERY},
    extracted AS (${EXTRACT_ATTRS})
    SELECT
        COALESCE(session_id, '(no session)') as session_id,
        COALESCE(model, '(unknown)') as model,
        ROUND(COALESCE(cost, 0), 6) as cost,
        COALESCE(input_tokens, 0) as input_tokens,
        COALESCE(output_tokens, 0) as output_tokens,
        duration_ms as latency_ms,
        COALESCE(agent_id, '') as agent_id,
        COALESCE(request_id, '') as request_id,
        to_timestamp(start_ms / 1000) as timestamp
    FROM extracted
    ORDER BY start_ms DESC
    LIMIT 1;
    "
}

query_custom() {
    local sql="$1"
    check_traces

    # Catch common shell-expansion pitfall:
    # --sql "${BASE_QUERY}, extracted AS (${EXTRACT_ATTRS}) ..."
    # If BASE_QUERY/EXTRACT_ATTRS are not defined in the caller shell, this becomes invalid SQL.
    if [[ "${sql}" == *"extracted AS ()"* ]] || [[ "${sql}" == *"attrs AS ()"* ]]; then
        echo "Invalid SQL: CTE placeholders were expanded to empty by your shell."
        echo "Hint: wrap --sql in single quotes, e.g.:"
        echo "  --sql '\${BASE_QUERY}, extracted AS (\${EXTRACT_ATTRS}) SELECT COUNT(*) FROM extracted'"
        exit 1
    fi

    # Support callers that pass placeholders literally (e.g. Python subprocess):
    #   ${BASE_QUERY}, extracted AS (${EXTRACT_ATTRS}) ...
    local expanded_sql="${sql//\$\{BASE_QUERY\}/${BASE_QUERY}}"
    expanded_sql="${expanded_sql//\$\{EXTRACT_ATTRS\}/${EXTRACT_ATTRS}}"
    expanded_sql="${expanded_sql//\$BASE_QUERY/${BASE_QUERY}}"
    expanded_sql="${expanded_sql//\$EXTRACT_ATTRS/${EXTRACT_ATTRS}}"
    run_duckdb_sql "${expanded_sql}"
}

interactive_shell() {
    check_traces
    echo "🦆 DuckDB Interactive Shell"
    echo "==========================="
    echo ""
    if has_indexed_db; then
        echo "Indexed DB: ${INDEX_DB_PATH}"
        echo ""
        echo "Example queries:"
        echo "  SELECT * FROM sessions ORDER BY ended_at DESC LIMIT 5;"
        echo "  SELECT session_id, request_id, start_ms FROM model_calls ORDER BY start_ms DESC LIMIT 20;"
        echo ""
        ${DUCKDB} -readonly "${INDEX_DB_PATH}"
    else
        echo "Trace files: ${TRACES_DIR}/*.jsonl"
        echo ""
        echo "Example queries:"
        echo "  SELECT * FROM read_json('${TRACES_DIR}/*.jsonl') LIMIT 5;"
        echo ""
        ${DUCKDB}
    fi
}

dump_schema() {
    if ! has_indexed_db; then
        echo '{"error": "Indexed analytics DB not found. Schema discovery requires analytics.duckdb."}' | python3 -m json.tool
        exit 1
    fi

    INDEX_DB_PATH="${INDEX_DB_PATH}" DUCKDB_BIN="${DUCKDB}" python3 << 'PYTHON_EOF'
import json
import subprocess
import sys
import os

db_path = os.environ.get('INDEX_DB_PATH', '')
duckdb_bin = os.environ.get('DUCKDB_BIN', 'duckdb')
if not db_path:
    print('{"error": "INDEX_DB_PATH not set"}', file=sys.stderr)
    sys.exit(1)

def run_query(sql):
    """Run DuckDB query and return JSON results."""
    result = subprocess.run(
        [duckdb_bin, '-readonly', db_path, '-json', '-c', sql],
        capture_output=True,
        text=True
    )
    if result.returncode != 0:
        print(f"Error: {result.stderr}", file=sys.stderr)
        return []
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return []

# Fetch all tables
tables = run_query("""
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'main'
    ORDER BY table_name
""")

# Fetch all columns with types and indices
columns = run_query("""
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'main'
    ORDER BY table_name, ordinal_position
""")

# Fetch primary keys
pks = run_query("""
    SELECT table_name, column_name
    FROM information_schema.key_column_usage
    WHERE table_schema = 'main' AND constraint_type = 'PRIMARY KEY'
    ORDER BY table_name, ordinal_position
""")

# Fetch foreign keys
fks = run_query("""
    SELECT
        table_name,
        column_name,
        constraint_name
    FROM information_schema.key_column_usage
    WHERE table_schema = 'main' AND constraint_type = 'FOREIGN KEY'
    ORDER BY table_name
""")

# Fetch index info
indices = run_query("""
    SELECT table_name, index_name, expressions
    FROM duckdb_indexes()
    ORDER BY table_name
""")

# Build output structure
pk_set = set((row['table_name'], row['column_name']) for row in pks)
col_map = {}
for row in columns:
    tbl = row['table_name']
    if tbl not in col_map:
        col_map[tbl] = []
    col_map[tbl].append({
        'name': row['column_name'],
        'type': row['data_type'],
        'is_primary_key': (tbl, row['column_name']) in pk_set
    })

idx_map = {}
for row in indices:
    tbl = row['table_name']
    if tbl not in idx_map:
        idx_map[tbl] = []
    idx_map[tbl].append({
        'name': row['index_name'],
        'expressions': row['expressions']
    })

schema = {
    'tables': [
        {
            'name': t['table_name'],
            'columns': col_map.get(t['table_name'], []),
            'indices': idx_map.get(t['table_name'], [])
        }
        for t in tables
    ],
    'relationships': [
        {
            'table': fk['table_name'],
            'column': fk['column_name'],
            'constraint': fk['constraint_name']
        }
        for fk in fks
    ]
}

print(json.dumps(schema, indent=2))
PYTHON_EOF
}

# Parse --since duration to milliseconds (e.g., 24h, 7d, 1h)
parse_since() {
    local since="$1"
    local num="${since%[hdm]}"
    local unit="${since: -1}"
    case "${unit}" in
        h) echo $(( num * 3600000 )) ;;
        d) echo $(( num * 86400000 )) ;;
        m) echo $(( num * 60000 )) ;;
        *) echo "86400000" ;;  # default 24h
    esac
}

# Main
case "${1:-}" in
    --cost)
        query_total_cost_fast
        ;;
    --cost-by-session|--sessions)
        query_cost_by_session_fast
        ;;
    --cost-by-model|--models)
        query_cost_by_model_fast
        ;;
    --cost-by-pack|--agents)
        query_cost_by_pack_fast
        ;;
    --cost-by-engine)
        query_cost_by_engine_fast
        ;;
    --cost-by-source)
        query_cost_by_source_fast
        ;;
    --cost-per-request)
        query_cost_per_request_fast "${2:-}"
        ;;
    --session)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --session <session-id>"
            exit 1
        fi
        query_session_fast "$2"
        ;;
    --session-summary)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --session-summary <session-id>"
            exit 1
        fi
        query_session_summary_fast "$2"
        ;;
    --session-debug)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --session-debug <session-id>"
            exit 1
        fi
        query_session_debug "$2"
        ;;
    --session-last)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --session-last <session-id> [limit]"
            exit 1
        fi
        query_session_last_messages "$2" "${3:-8}"
        ;;
    --session-messages|--messages)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --session-messages <session-id>"
            exit 1
        fi
        query_session_last_messages "$2" "${3:-8}"
        ;;
    --session-tools)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --session-tools <session-id>"
            exit 1
        fi
        query_session_tools "$2"
        ;;
    --recent-messages)
        query_recent_messages "${2:-20}"
        ;;
    --last-session-messages)
        query_last_session_messages "${2:-8}"
        ;;
    --request)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --request <request-id>"
            exit 1
        fi
        query_request_fast "$2"
        ;;
    --latest-session)
        query_latest_session_fast
        ;;
    --kpis-daily)
        query_agent_kpis_daily
        ;;
    --training-examples)
        query_training_examples "${2:-20}"
        ;;
    --session-timeline)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --session-timeline <session-id>"
            exit 1
        fi
        query_session_timeline_fast "$2"
        ;;
    --compare-versions)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --compare-versions <agent-name>"
            exit 1
        fi
        query_compare_versions_fast "$2"
        ;;
    --top-sessions)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --top-sessions <agent-name> [--since <duration>]"
            exit 1
        fi
        local_since="86400000"
        if [[ "${3:-}" == "--since" && -n "${4:-}" ]]; then
            local_since=$(parse_since "$4")
        fi
        query_top_sessions_fast "$2" "${local_since}"
        ;;
    --latency-percentiles|--latency)
        query_latency_percentiles
        ;;
    --errors)
        query_errors
        ;;
    --largest-requests)
        query_largest_requests "${2:-20}"
        ;;
    --problems)
        query_problems
        ;;
    --tool-loops)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --tool-loops <session-id>"
            exit 1
        fi
        query_tool_loops "$2"
        ;;
    --tool-stats)
        query_tool_stats "${2:-}"
        ;;
    --sql)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 --sql \"SELECT ...\""
            exit 1
        fi
        query_custom "$2"
        ;;
    --schema)
        dump_schema
        ;;
    --help|-h)
        echo "Usage: $0 [flag] [args]"
        echo ""
        echo "COST ANALYSIS — \"Where is money going?\""
        echo "  --cost                  Total cost, tokens, request count"
        echo "  --cost-by-session       Cost per session — find expensive conversations"
        echo "  --cost-by-model         Cost per model — check tier usage"
        echo "  --cost-by-pack          Cost per agent — compare agent efficiency"
        echo "  --cost-by-engine        Cost per engine (claude/codex/etc)"
        echo "  --cost-by-source        Cost per framework (vscode/cli/api)"
        echo "  --cost-per-request [id] Cost per user message — find bloated requests"
        echo ""
        echo "DEBUGGING — \"What happened in this session/request?\""
        echo "  --session <id>          All LLM calls in a session"
        echo "  --session-summary <id>  Session-level totals and metadata"
        echo "  --session-debug <id>    Compact agent-safe bundle: summary, requests, tools, latest messages"
        echo "  --session-last <id> [N] Last N conversational user/assistant previews from latest call snapshot"
        echo "  --session-messages <id> Alias of --session-last"
        echo "  --session-tools <id>    Tool calls and outcomes in session"
        echo "  --request <id>          All LLM calls for one user message"
        echo "  --latest-session        Most recent session summary"
        echo "  --last-session-messages [N] Last N messages for latest session"
        echo "  --recent-messages [N]   Most recent sessions by latest call"
        echo "  --session-timeline <id> Interleaved model/tool timeline"
        echo "  --kpis-daily            Daily KPI rollup from indexed DB"
        echo "  --training-examples [N] Retired (prints guidance)"
        echo ""
        echo "REGRESSION — \"Did performance change?\""
        echo "  --compare-versions <agent>  Avg cost/tokens/latency by agent version"
        echo "  --top-sessions <agent>      Expensive sessions for an agent (last 24h)"
        echo ""
        echo "HEALTH — \"What's broken?\""
        echo "  --problems              Statistical outliers (cost/token/latency spikes)"
        echo "  --errors                Error rate by model"
        echo "  --latency-percentiles   p50/p95 latency by model and agent"
        echo "  --largest-requests [N]  Biggest input token payloads (prompt bloat)"
        echo "  --tool-loops <id>       Detect repeated tool calls (possible loops)"
        echo "  --tool-stats [id]       Tool usage frequency and error rates"
        echo ""
        echo "DISCOVERY — \"Agent self-service schema learning\""
        echo "  --schema                All tables, columns, types, and relationships (JSON for agents)"
        echo "  (no args)               Interactive DuckDB shell"
        echo ""
        echo "CUSTOM — \"I need something specific\""
        echo "  --sql \"SELECT ...\"      Run custom DuckDB SQL"
        echo ""
        echo "The --sql flag can use built-in CTEs for complex queries:"
        echo "  \${BASE_QUERY}   — flattens OTEL JSONL into spans"
        echo "  \${EXTRACT_ATTRS} — extracts common attributes (cost, model, session, etc)"
        echo ""
        echo "Example: scripts/query-analytics.sh --sql \"\${BASE_QUERY}, attrs AS (\${EXTRACT_ATTRS}) SELECT model, SUM(cost) FROM attrs GROUP BY model\""
        echo ""
        echo "Options:"
        echo "  --since <dur>           Time filter for --top-sessions (24h, 7d, 30m)"
        echo ""
        echo "Message previews are bounded by default and may spill a fuller preview artifact to ${TMP_DIR}."
        ;;
    *)
        interactive_shell
        ;;
esac
