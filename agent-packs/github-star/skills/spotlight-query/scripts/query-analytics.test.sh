#!/usr/bin/env bash
#
# Copyright (c) AgentHippo.ai. All rights reserved.
#
# Tests for query-analytics.sh
#
# Usage: ./query-analytics.test.sh
#
# Requires: duckdb in PATH
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERY_SCRIPT="${SCRIPT_DIR}/query-analytics.sh"
FIXTURES_DIR="${SCRIPT_DIR}/test-fixtures"
TEST_HOME="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-query-tests-XXXXXX")"
trap 'rm -rf "${TEST_HOME}"' EXIT

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Set up test environment
mkdir -p "${TEST_HOME}"
cp -R "${FIXTURES_DIR}/analytics" "${TEST_HOME}/analytics"
export AGENT_HOME_DIR="${TEST_HOME}"
export AGENTIDE_ANALYTICS_TMP_DIR="${AGENT_HOME_DIR}/analytics/tmp"

create_indexed_fixture_db() {
    local db_path="${AGENT_HOME_DIR}/analytics/traces/analytics.duckdb"
    mkdir -p "$(dirname "${db_path}")"
    duckdb "${db_path}" <<'SQL'
CREATE TABLE sessions (
    session_id VARCHAR,
    agent_id VARCHAR,
    agent_version VARCHAR,
    engine VARCHAR,
    status VARCHAR,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    total_turns BIGINT,
    total_requests BIGINT,
    total_cost_usd DOUBLE,
    total_tokens BIGINT
);

CREATE TABLE turns (
    turn_id VARCHAR,
    session_id VARCHAR,
    request_id VARCHAR
);

CREATE TABLE model_calls (
    session_id VARCHAR,
    trace_id VARCHAR,
    turn_id VARCHAR,
    request_id VARCHAR,
    start_ms BIGINT,
    model VARCHAR,
    agent_id VARCHAR,
    agent_version VARCHAR,
    source VARCHAR,
    engine VARCHAR,
    total_cost_usd DOUBLE,
    prompt_tokens BIGINT,
    completion_tokens BIGINT,
    duration_ms DOUBLE,
    total_tokens BIGINT,
    status VARCHAR,
    input_messages_raw VARCHAR,
    output_messages_raw VARCHAR
);

CREATE TABLE tool_calls (
    session_id VARCHAR,
    request_id VARCHAR,
    call_ts TIMESTAMP,
    tool_name VARCHAR,
    status VARCHAR,
    duration_ms DOUBLE,
    arguments_text VARCHAR,
    result_text VARCHAR,
    error_message VARCHAR
);

INSERT INTO sessions VALUES
    ('sess-test-1', 'code-reviewer', '1.1.0', 'claude', 'completed', '2023-11-14 22:13:20', '2023-11-14 22:14:10', 2, 2, 0.140000, 16300),
    ('sess-test-2', 'bug-fixer', '2.0.0', 'codex', 'completed', '2023-11-14 22:15:00', '2023-11-14 22:15:30', 1, 1, 0.050000, 6500),
    ('sess-test-3', 'code-reviewer', '1.1.0', 'claude', 'error', '2023-11-14 22:16:00', '2023-11-14 22:16:02', 1, 1, 0.000000, 0);

INSERT INTO turns VALUES
    ('turn-001', 'sess-test-1', 'req-001'),
    ('turn-002', 'sess-test-1', 'req-003'),
    ('turn-003', 'sess-test-2', 'req-002'),
    ('turn-004', 'sess-test-3', 'req-004');

INSERT INTO model_calls VALUES
    (
        'sess-test-1',
        'trace-001',
        'turn-001',
        'req-001',
        1700000000000,
        'gpt-4o',
        'code-reviewer',
        '1.0.0',
        'agenthippo',
        'claude',
        0.015,
        1000,
        500,
        1500,
        1500,
        'success',
        '[{"role":"system","content":"Be concise"},{"role":"user","content":"Need help debugging the Read tool loop. ' || repeat('alpha ', 220) || ' USER_TAIL_MARKER_001"},{"role":"assistant","content":"Investigating previous attempts."}]',
        '[{"role":"assistant","content":"I checked the Read tool path and found repeated retries. ' || repeat('beta ', 180) || ' OUTPUT_TAIL_MARKER_001"}]'
    ),
    (
        'sess-test-1',
        'trace-002',
        'turn-001',
        'req-001',
        1700000002000,
        'gpt-4o',
        'code-reviewer',
        '1.0.0',
        'agenthippo',
        'claude',
        0.025,
        2000,
        800,
        1000,
        2800,
        'success',
        '[{"role":"user","content":"Try a second pass with the same file."}]',
        '[{"role":"assistant","content":"Second pass completed successfully."}]'
    ),
    (
        'sess-test-2',
        'trace-003',
        'turn-003',
        'req-002',
        1700000100000,
        'claude-3-5-sonnet-20241022',
        'bug-fixer',
        '2.0.0',
        'agenthippo',
        'codex',
        0.050,
        5000,
        1500,
        2100,
        6500,
        'success',
        '[{"role":"user","content":"Fix the production bug."}]',
        '[{"role":"assistant","content":"Applied the remediation."}]'
    ),
    (
        'sess-test-1',
        'trace-004',
        'turn-002',
        'req-003',
        1700000200000,
        'gpt-4o',
        'code-reviewer',
        '1.1.0',
        'agenthippo',
        'claude',
        0.100,
        10000,
        2000,
        2300,
        12000,
        'success',
        '[{"role":"user","parts":[{"type":"text","text":"<system-reminder>repo context ' || repeat('alpha ', 180) || ' REMINDER_PART_0</system-reminder>"},{"type":"text","text":"<system-reminder>workspace note ' || repeat('beta ', 160) || ' REMINDER_PART_1</system-reminder>"},{"type":"text","text":"<system-reminder>skills list ' || repeat('gamma ', 140) || ' REMINDER_PART_2</system-reminder>"},{"type":"text","text":"<system-reminder>todo note ' || repeat('delta ', 120) || ' REMINDER_PART_3</system-reminder>"},{"type":"text","text":"hello dude USER_TAIL_MARKER_999\n\n## Attached Context\n- file: src/app.ts"}]},{"role":"assistant","parts":[{"type":"thinking","text":"internal"},{"type":"text","text":"Working on the final answer."}]}]',
        '[{"role":"assistant","parts":[{"type":"text","text":"The final debugging state is stable. ' || repeat('delta ', 240) || ' OUTPUT_TAIL_MARKER_999"}]}]'
    );

INSERT INTO tool_calls VALUES
    ('sess-test-1', 'req-001', '2023-11-14 22:13:20.100', 'Read', 'success', 100, '{"path":"src/app.ts"}', '{"bytes":120}', ''),
    ('sess-test-1', 'req-001', '2023-11-14 22:13:20.300', 'Read', 'success', 100, '{"path":"src/app.ts"}', '{"bytes":120}', ''),
    ('sess-test-1', 'req-001', '2023-11-14 22:13:20.500', 'Read', 'success', 100, '{"path":"src/app.ts"}', '{"bytes":120}', ''),
    ('sess-test-1', 'req-001', '2023-11-14 22:13:20.700', 'Read', 'success', 100, '{"path":"src/app.ts"}', '{"bytes":120}', ''),
    ('sess-test-1', 'req-001', '2023-11-14 22:13:20.900', 'Read', 'success', 100, '{"path":"src/app.ts"}', '{"bytes":120}', ''),
    ('sess-test-1', 'req-001', '2023-11-14 22:13:21.100', 'Read', 'error', 100, '{"path":"src/app.ts"}', '', 'disk read failed'),
    ('sess-test-1', 'req-003', '2023-11-14 22:14:01.000', 'Search', 'success', 45, '{"query":"tool retry"}', '{"matches":3}', '');
SQL
}

create_indexed_fixture_db

# =============================================================================
# Test helpers
# =============================================================================

assert_contains() {
    local output="$1"
    local expected="$2"
    local test_name="$3"

    TESTS_RUN=$((TESTS_RUN + 1))
    if echo "$output" | grep -q -- "$expected"; then
        echo -e "${GREEN}✓${NC} $test_name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗${NC} $test_name"
        echo "  Expected to contain: $expected"
        echo "  Got: ${output:0:200}..."
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

assert_not_empty() {
    local output="$1"
    local test_name="$2"

    TESTS_RUN=$((TESTS_RUN + 1))
    if [[ -n "$output" ]]; then
        echo -e "${GREEN}✓${NC} $test_name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗${NC} $test_name"
        echo "  Expected non-empty output"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

assert_exit_code() {
    local expected_code="$1"
    local actual_code="$2"
    local test_name="$3"

    TESTS_RUN=$((TESTS_RUN + 1))
    if [[ "$actual_code" -eq "$expected_code" ]]; then
        echo -e "${GREEN}✓${NC} $test_name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗${NC} $test_name"
        echo "  Expected exit code: $expected_code, got: $actual_code"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

assert_file_exists() {
    local path="$1"
    local test_name="$2"

    TESTS_RUN=$((TESTS_RUN + 1))
    if [[ -f "$path" ]]; then
        echo -e "${GREEN}✓${NC} $test_name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗${NC} $test_name"
        echo "  Expected file to exist: $path"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

# =============================================================================
# Preflight checks
# =============================================================================

echo "================================================"
echo "query-analytics.sh Test Suite"
echo "================================================"
echo ""
echo "Script: ${QUERY_SCRIPT}"
echo "Fixtures: ${FIXTURES_DIR}"
echo ""

# Check duckdb is available
if ! command -v duckdb &> /dev/null; then
    echo -e "${RED}ERROR: duckdb not found in PATH${NC}"
    echo "Install with: brew install duckdb"
    exit 1
fi

# Check script exists
if [[ ! -x "${QUERY_SCRIPT}" ]]; then
    chmod +x "${QUERY_SCRIPT}"
fi

# Check fixtures exist
if [[ ! -f "${FIXTURES_DIR}/analytics/traces/sample.jsonl" ]]; then
    echo -e "${RED}ERROR: Test fixtures not found${NC}"
    exit 1
fi

echo -e "${GREEN}Preflight checks passed${NC}"
echo ""

# =============================================================================
# Test: --help
# =============================================================================

echo "--- --help ---"

output=$("${QUERY_SCRIPT}" --help 2>&1)
assert_contains "$output" "COST ANALYSIS" "--help shows COST ANALYSIS section"
assert_contains "$output" "DEBUGGING" "--help shows DEBUGGING section"
assert_contains "$output" "--session-debug" "--help documents --session-debug"
assert_contains "$output" "REGRESSION" "--help shows REGRESSION section"
assert_contains "$output" "HEALTH" "--help shows HEALTH section"
assert_contains "$output" "CUSTOM" "--help shows CUSTOM section"
assert_contains "$output" '\${BASE_QUERY}' "--help documents BASE_QUERY CTE"
echo ""

# =============================================================================
# Test: --cost
# =============================================================================

echo "--- --cost ---"

output=$("${QUERY_SCRIPT}" --cost 2>&1)
assert_contains "$output" "Total Cost Summary" "--cost shows title"
assert_contains "$output" "total_cost" "--cost shows total_cost column"
assert_contains "$output" "total_input_tokens" "--cost shows input tokens"
# Fixture has 5 spans but only 4 with cost data (trace-005 is an error without cost)
# Total cost = 0.015 + 0.025 + 0.050 + 0.100 = 0.19
assert_contains "$output" "0.19" "--cost shows correct total (0.19)"
echo ""

# =============================================================================
# Test: --cost-by-session
# =============================================================================

echo "--- --cost-by-session ---"

output=$("${QUERY_SCRIPT}" --cost-by-session 2>&1)
assert_contains "$output" "Cost by Session" "--cost-by-session shows title"
assert_contains "$output" "sess-test-1" "--cost-by-session shows session ID"
assert_contains "$output" "sess-test-2" "--cost-by-session shows second session"
echo ""

# =============================================================================
# Test: --cost-by-model
# =============================================================================

echo "--- --cost-by-model ---"

output=$("${QUERY_SCRIPT}" --cost-by-model 2>&1)
assert_contains "$output" "Cost by Model" "--cost-by-model shows title"
assert_contains "$output" "gpt-4o" "--cost-by-model shows gpt-4o"
assert_contains "$output" "claude-3-5-sonnet" "--cost-by-model shows claude model"
echo ""

# =============================================================================
# Test: --cost-by-pack
# =============================================================================

echo "--- --cost-by-pack ---"

output=$("${QUERY_SCRIPT}" --cost-by-pack 2>&1)
assert_contains "$output" "Cost by Agent" "--cost-by-pack shows title"
assert_contains "$output" "code-reviewer" "--cost-by-pack shows code-reviewer agent"
assert_contains "$output" "bug-fixer" "--cost-by-pack shows bug-fixer agent"
echo ""

# =============================================================================
# Test: --cost-by-engine
# =============================================================================

echo "--- --cost-by-engine ---"

output=$("${QUERY_SCRIPT}" --cost-by-engine 2>&1)
assert_contains "$output" "Cost by Engine" "--cost-by-engine shows title"
assert_contains "$output" "claude" "--cost-by-engine shows claude engine"
assert_contains "$output" "codex" "--cost-by-engine shows codex engine"
echo ""

# =============================================================================
# Test: --cost-by-source
# =============================================================================

echo "--- --cost-by-source ---"

output=$("${QUERY_SCRIPT}" --cost-by-source 2>&1)
assert_contains "$output" "Cost by Source" "--cost-by-source shows title"
assert_contains "$output" "agenthippo" "--cost-by-source shows agenthippo source"
echo ""

# =============================================================================
# Test: --session <id>
# =============================================================================

echo "--- --session ---"

output=$("${QUERY_SCRIPT}" --session sess-test-1 2>&1)
assert_contains "$output" "Session: sess-test-1" "--session shows session ID in title"
assert_contains "$output" "gpt-4o" "--session shows model"
assert_contains "$output" "req-001" "--session shows request ID"
echo ""

# =============================================================================
# Test: --session-debug <id>
# =============================================================================

echo "--- --session-debug ---"

output=$("${QUERY_SCRIPT}" --session-debug sess-test-1 2>&1)
assert_contains "$output" "Session Debug: sess-test-1" "--session-debug shows title"
assert_contains "$output" "Recent Requests" "--session-debug shows recent requests section"
assert_contains "$output" "Tool Signals" "--session-debug shows tool signals section"
assert_contains "$output" "tail preview truncated" "--session-debug shows bounded message preview"
assert_contains "$output" "OUTPUT_TAIL_MARKER_999" "--session-debug includes final assistant output preview"
echo ""

# =============================================================================
# Test: --latest-session
# =============================================================================

echo "--- --latest-session ---"

output=$("${QUERY_SCRIPT}" --latest-session 2>&1)
assert_contains "$output" "Latest Session" "--latest-session shows title"
assert_contains "$output" "sess-test-3" "--latest-session shows latest session ID"
assert_contains "$output" "code-reviewer" "--latest-session shows agent"
echo ""

# =============================================================================
# Test: --session-last <id> [N]
# =============================================================================

echo "--- --session-last ---"

output=$("${QUERY_SCRIPT}" --session-last sess-test-1 4 2>&1)
assert_contains "$output" "safe preview" "--session-last labels safe preview mode"
assert_contains "$output" "tail preview truncated" "--session-last indicates truncation"
assert_contains "$output" "per-part tail preview" "--session-last uses per-part tail previews for multipart input"
assert_contains "$output" "hello dude USER_TAIL_MARKER_999" "--session-last keeps the final user part visible"
assert_contains "$output" "Working on the final answer." "--session-last extracts assistant text from later part"
assert_contains "$output" "OUTPUT_TAIL_MARKER_999" "--session-last includes tail of final assistant output"
artifact_path="$(printf '%s\n' "$output" | grep -oE "${AGENTIDE_ANALYTICS_TMP_DIR}/[^[:space:]]+" | tail -n 1)"
assert_not_empty "$artifact_path" "--session-last emits artifact path"
assert_file_exists "$artifact_path" "--session-last writes message artifact"
artifact_output="$(cat "$artifact_path")"
assert_contains "$artifact_output" "USER_TAIL_MARKER_999" "--session-last artifact keeps full user message content"
assert_contains "$artifact_output" "## Attached Context" "--session-last artifact retains attached context details"
echo ""

# =============================================================================
# Test: --session-last trace fallback
# =============================================================================

echo "--- --session-last (trace fallback) ---"

TRACE_ONLY_HOME="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-query-trace-only-XXXXXX")"
trap 'rm -rf "${TEST_HOME}" "${TRACE_ONLY_HOME:-}"' EXIT
mkdir -p "${TRACE_ONLY_HOME}/analytics/traces"
python3 - "${TRACE_ONLY_HOME}/analytics/traces/sample.jsonl" <<'PY'
import json
import pathlib
import sys

out_path = pathlib.Path(sys.argv[1])
payload = {
    "resourceSpans": [
        {
            "scopeSpans": [
                {
                    "spans": [
                        {
                            "traceId": "trace-fallback-1",
                            "spanId": "span-fallback-1",
                            "name": "Received Proxy Server Request",
                            "startTimeUnixNano": "1700000300000000000",
                            "endTimeUnixNano": "1700000301500000000",
                            "attributes": [
                                {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o"}},
                                {
                                    "key": "metadata.requester_custom_headers",
                                    "value": {
                                        "stringValue": "{'x-litellm-metadata-session-id': 'sess-trace-1', 'x-litellm-metadata-request-id': 'req-trace-1'}"
                                    },
                                },
                                {
                                    "key": "gen_ai.input.messages",
                                    "value": {
                                            "stringValue": json.dumps([
                                            {"role": "user", "content": "Trace fallback user message " + ("omega " * 220) + " TRACE_TAIL_MARKER_USER"},
                                            {"role": "assistant", "content": "Trace fallback assistant draft"},
                                        ])
                                    },
                                },
                                {
                                    "key": "gen_ai.output.messages",
                                    "value": {
                                        "stringValue": json.dumps([
                                            {"role": "assistant", "content": "Trace fallback assistant output " + ("sigma " * 200) + " TRACE_TAIL_MARKER_OUTPUT"}
                                        ])
                                    },
                                },
                            ],
                        }
                    ]
                }
            ]
        }
    ]
}
out_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
PY

output=$(AGENT_HOME_DIR="${TRACE_ONLY_HOME}" AGENTIDE_ANALYTICS_TMP_DIR="${TRACE_ONLY_HOME}/analytics/tmp" "${QUERY_SCRIPT}" --session-last sess-trace-1 2 2>&1)
assert_contains "$output" "trace parse, safe preview" "--session-last trace fallback announces safe preview"
assert_contains "$output" "tail preview truncated" "--session-last trace fallback truncates large content"
assert_contains "$output" "TRACE_TAIL_MARKER_OUTPUT" "--session-last trace fallback keeps tail of truncated message"
trace_artifact_path="$(printf '%s\n' "$output" | grep -oE "${TRACE_ONLY_HOME}/analytics/tmp/[^[:space:]]+" | tail -n 1)"
assert_not_empty "$trace_artifact_path" "--session-last trace fallback emits artifact path"
assert_file_exists "$trace_artifact_path" "--session-last trace fallback writes artifact"
trace_artifact_output="$(cat "$trace_artifact_path")"
assert_contains "$trace_artifact_output" "Trace fallback assistant output" "--session-last trace fallback artifact keeps full assistant message content"
rm -rf "${TRACE_ONLY_HOME}"
unset TRACE_ONLY_HOME
echo ""

# =============================================================================
# Test: --request <id>
# =============================================================================

echo "--- --request ---"

output=$("${QUERY_SCRIPT}" --request req-001 2>&1)
assert_contains "$output" "Request: req-001" "--request shows request ID in title"
assert_contains "$output" "gpt-4o" "--request shows model"
echo ""

# =============================================================================
# Test: --cost-per-request
# =============================================================================

echo "--- --cost-per-request ---"

output=$("${QUERY_SCRIPT}" --cost-per-request sess-test-1 2>&1)
assert_contains "$output" "Cost per Request" "--cost-per-request shows title"
assert_contains "$output" "req-001" "--cost-per-request shows request ID"
assert_contains "$output" "req-003" "--cost-per-request shows second request ID"
echo ""

# =============================================================================
# Test: --compare-versions
# =============================================================================

echo "--- --compare-versions ---"

output=$("${QUERY_SCRIPT}" --compare-versions code-reviewer 2>&1)
assert_contains "$output" "Compare Versions" "--compare-versions shows title"
assert_contains "$output" "1.0.0" "--compare-versions shows version 1.0.0"
assert_contains "$output" "1.1.0" "--compare-versions shows version 1.1.0"
echo ""

# =============================================================================
# Test: --top-sessions
# =============================================================================

echo "--- --top-sessions ---"

output=$("${QUERY_SCRIPT}" --top-sessions code-reviewer 2>&1)
assert_contains "$output" "Top Sessions" "--top-sessions shows title"
assert_contains "$output" "code-reviewer" "--top-sessions shows agent name"
echo ""

# =============================================================================
# Test: --latency-percentiles
# =============================================================================

echo "--- --latency-percentiles ---"

output=$("${QUERY_SCRIPT}" --latency-percentiles 2>&1)
assert_contains "$output" "Latency Percentiles" "--latency-percentiles shows title"
assert_contains "$output" "p50_ms" "--latency-percentiles shows p50"
assert_contains "$output" "p95_ms" "--latency-percentiles shows p95"
echo ""

# =============================================================================
# Test: --errors
# =============================================================================

echo "--- --errors ---"

output=$("${QUERY_SCRIPT}" --errors 2>&1)
assert_contains "$output" "Error Rate" "--errors shows title"
# We have 1 error span (trace-005) out of 5 total
assert_not_empty "$output" "--errors returns output"
echo ""

# =============================================================================
# Test: --largest-requests
# =============================================================================

echo "--- --largest-requests ---"

output=$("${QUERY_SCRIPT}" --largest-requests 2>&1)
assert_contains "$output" "Largest Requests" "--largest-requests shows title"
assert_contains "$output" "10000" "--largest-requests shows largest input (10000 tokens)"
echo ""

# =============================================================================
# Test: --problems
# =============================================================================

echo "--- --problems ---"

output=$("${QUERY_SCRIPT}" --problems 2>&1)
assert_contains "$output" "Problem Sessions" "--problems shows title"
# Fixture has outliers - sess-test-1 has more tokens than average
assert_not_empty "$output" "--problems returns output"
echo ""

# =============================================================================
# Test: --tool-stats (session events)
# =============================================================================

echo "--- --tool-stats ---"

output=$("${QUERY_SCRIPT}" --tool-stats sess-test-1 2>&1)
assert_contains "$output" "Tool Usage Statistics" "--tool-stats shows title"
assert_contains "$output" "Read" "--tool-stats shows Read tool"
# Fixture has 6 Read tool calls
assert_contains "$output" "6" "--tool-stats shows 6 calls"
echo ""

# =============================================================================
# Test: --tool-loops (session events)
# =============================================================================

echo "--- --tool-loops ---"

output=$("${QUERY_SCRIPT}" --tool-loops sess-test-1 2>&1)
assert_contains "$output" "Tool Loop Detection" "--tool-loops shows title"
assert_contains "$output" "Read" "--tool-loops shows Read tool"
assert_contains "$output" "POSSIBLE LOOP" "--tool-loops detects loop (>5 calls)"
echo ""

# =============================================================================
# Test: --session-timeline (session events)
# =============================================================================

echo "--- --session-timeline ---"

output=$("${QUERY_SCRIPT}" --session-timeline sess-test-1 2>&1)
assert_contains "$output" "Session Timeline" "--session-timeline shows title"
assert_contains "$output" "llm_call" "--session-timeline shows LLM calls"
assert_contains "$output" "tool_call" "--session-timeline shows indexed tool events"
echo ""

# =============================================================================
# Test: Flag aliases
# =============================================================================

echo "--- Aliases ---"

output=$("${QUERY_SCRIPT}" --sessions 2>&1)
assert_contains "$output" "Cost by Session" "--sessions alias works"

output=$("${QUERY_SCRIPT}" --models 2>&1)
assert_contains "$output" "Cost by Model" "--models alias works"

output=$("${QUERY_SCRIPT}" --agents 2>&1)
assert_contains "$output" "Cost by Agent" "--agents alias works"

output=$("${QUERY_SCRIPT}" --latency 2>&1)
assert_contains "$output" "Latency Percentiles" "--latency alias works"
echo ""

# =============================================================================
# Test: --sql (custom query)
# =============================================================================

echo "--- --sql ---"

output=$("${QUERY_SCRIPT}" --sql "SELECT COUNT(*) as span_count FROM read_json('${FIXTURES_DIR}/analytics/traces/*.jsonl')" 2>&1)
assert_contains "$output" "5" "--sql custom query returns 5 spans"
echo ""

# =============================================================================
# Test: Missing argument errors
# =============================================================================

echo "--- Error handling ---"

set +e  # Don't exit on error for these tests

output=$("${QUERY_SCRIPT}" --session 2>&1)
exit_code=$?
assert_exit_code 1 "$exit_code" "--session without ID exits with code 1"
assert_contains "$output" "Usage:" "--session without ID shows usage"

output=$("${QUERY_SCRIPT}" --request 2>&1)
exit_code=$?
assert_exit_code 1 "$exit_code" "--request without ID exits with code 1"

output=$("${QUERY_SCRIPT}" --compare-versions 2>&1)
exit_code=$?
assert_exit_code 1 "$exit_code" "--compare-versions without agent exits with code 1"

output=$("${QUERY_SCRIPT}" --tool-loops 2>&1)
exit_code=$?
assert_exit_code 1 "$exit_code" "--tool-loops without session exits with code 1"

output=$("${QUERY_SCRIPT}" --sql 2>&1)
exit_code=$?
assert_exit_code 1 "$exit_code" "--sql without query exits with code 1"

set -e

echo ""

# =============================================================================
# Summary
# =============================================================================

echo "================================================"
echo "Test Results"
echo "================================================"
echo ""
echo -e "Passed: ${GREEN}${TESTS_PASSED}${NC}"
echo -e "Failed: ${RED}${TESTS_FAILED}${NC}"
echo -e "Total:  ${TESTS_RUN}"
echo ""

if [[ ${TESTS_FAILED} -gt 0 ]]; then
    echo -e "${RED}FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}ALL TESTS PASSED${NC}"
    exit 0
fi
