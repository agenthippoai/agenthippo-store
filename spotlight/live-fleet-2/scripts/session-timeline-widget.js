#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findDuckdb } = require('./duckdbLocator');

const SESSION_LIMIT = 8;
const SESSION_OVERSCAN = 24;
const MAX_LLM_ROWS_PER_SESSION = 90;
const MAX_TOOL_CALLS_PER_SESSION = 200;
const MAX_TURN_EVENTS_PER_SESSION = 260;
const MAX_ERROR_EVENTS_PER_SESSION = 80;
const TEXT_PREVIEW_CHARS = 320;
const MAX_FULL_TEXT_CHARS_PER_FIELD = 32_000;
const GLOBAL_FULL_TEXT_BUDGET = 360_000;
const SQL_MESSAGE_FIELD_CHARS = 12_000; // cap SQL payload size to avoid duckdb JSON output buffer overflows.

function parseJsonArraysFromOutput(stdout) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === '[') {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }

    if (c === ']') {
      if (depth > 0) {
        depth--;
      }
      if (depth === 0 && start >= 0) {
        try {
          results.push(JSON.parse(stdout.slice(start, i + 1)));
        } catch {
          results.push([]);
        }
        start = -1;
      }
    }
  }

  return results;
}

function runSingleQuery(duckdbPath, sql, dbPath = '') {
  const settings = "SET memory_limit='4GB';\nSET threads TO 1;\nSET preserve_insertion_order=false";
  const args = [];
  if (dbPath) {
    args.push(dbPath);
  }
  args.push('-json', '-c', `${settings};\n${sql}`);
  const stdout = execFileSync(duckdbPath, args, {
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
  });
  const arrays = parseJsonArraysFromOutput(stdout);
  return arrays[0] || [];
}

function runBatchQueries(duckdbPath, queries, dbPath = '') {
  const settings = "SET memory_limit='4GB';\nSET threads TO 1;\nSET preserve_insertion_order=false";
  const allSql = settings + ';\n' + queries.map((q) => q.sql).join('\n');
  const args = [];
  if (dbPath) {
    args.push(dbPath);
  }
  args.push('-json', '-c', allSql);
  try {
    const stdout = execFileSync(duckdbPath, args, {
      encoding: 'utf8',
      maxBuffer: 40 * 1024 * 1024,
    });
    const arrays = parseJsonArraysFromOutput(stdout);
    const result = {};
    queries.forEach((q, i) => { result[q.name] = arrays[i] || []; });
    return { result, failed: false };
  } catch (err) {
    console.error(`session-timeline-widget batch query failed: ${err instanceof Error ? err.message : err}`);
    const fallbackResult = {};
    let anySuccess = false;
    for (const query of queries) {
      try {
        fallbackResult[query.name] = runSingleQuery(duckdbPath, query.sql, dbPath);
        anySuccess = true;
      } catch (singleErr) {
        console.error(`session-timeline-widget query fallback failed (${query.name}): ${singleErr instanceof Error ? singleErr.message : singleErr}`);
        fallbackResult[query.name] = [];
      }
    }
    return { result: fallbackResult, failed: !anySuccess };
  }
}

function getIndexedDbPath(tracesDir) {
  const configuredDbPath = String(process.env.AGENTIDE_INDEX_DB_PATH || '').trim();
  const fallbackDbPath = path.join(tracesDir, 'analytics.duckdb');
  const candidates = [configuredDbPath, fallbackDbPath].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // continue searching
    }
  }
  return '';
}

function buildBaseQuery(tracesDir, useIndexed = false) {
  if (useIndexed) {
    return `
WITH extracted AS (
  SELECT
    trace_id,
    COALESCE(span_name, 'Received Proxy Server Request') AS span_name,
    COALESCE(duration_ms, 0) AS duration_ms,
    COALESCE(start_ms, 0) AS start_ms,
    CASE WHEN COALESCE(status, '') = 'error' THEN 2 ELSE 0 END AS status_code,
    session_id,
    COALESCE(request_id, '') AS request_id,
    COALESCE(agent_id, '') AS agent_id,
    COALESCE(model, 'unknown') AS model,
    COALESCE(total_cost_usd, 0) AS cost,
    COALESCE(prompt_tokens, 0) AS input_tokens,
    COALESCE(completion_tokens, 0) AS output_tokens,
LEFT(COALESCE(input_messages_raw, ''), ${SQL_MESSAGE_FIELD_CHARS}) AS input_messages,
    LEFT(COALESCE(output_messages_raw, ''), ${SQL_MESSAGE_FIELD_CHARS}) AS output_messages
  FROM model_calls
  WHERE session_id IS NOT NULL AND session_id != ''
)
`;
  }

  const tracesGlob = `${tracesDir.replace(/'/g, "''")}/*.jsonl`;
  return `
WITH raw_spans AS (
  SELECT unnest(resourceSpans) AS rs
  FROM read_json('${tracesGlob}', format='newline_delimited', ignore_errors=true)
),
spans AS (
  SELECT unnest(rs.scopeSpans) AS ss
  FROM raw_spans
),
flat_spans AS (
  SELECT unnest(ss.spans) AS span
  FROM spans
),
parsed AS (
  SELECT
    span.traceId AS trace_id,
    span.spanId AS span_id,
    span.name AS span_name,
    span.startTimeUnixNano::BIGINT / 1000000 AS start_ms,
    span.endTimeUnixNano::BIGINT / 1000000 AS end_ms,
    (span.endTimeUnixNano::BIGINT - span.startTimeUnixNano::BIGINT) / 1000000 AS duration_ms,
    CAST(json_extract(to_json(span), '$.status.code') AS BIGINT) AS status_code,
    json_extract(to_json(span), '$.attributes') AS attrs_json
  FROM flat_spans
),
span_filter AS (
  SELECT trace_id, span_name, duration_ms, start_ms, status_code, attrs_json
  FROM parsed
  WHERE span_name = 'Received Proxy Server Request'
     OR span_name = 'Failed Proxy Server Request'
     OR EXISTS (
      SELECT 1
      FROM json_each(coalesce(attrs_json, '[]'::JSON)) AS attr
      WHERE json_extract_string(attr.value, '$.key') = 'gen_ai.cost.total_cost'
     )
),
attrs AS (
  SELECT
    trace_id,
    span_name,
    duration_ms,
    start_ms,
    status_code,
    json_extract_string(value, '$.key') AS attr_key,
    json_extract_string(value, '$.value.stringValue') AS attr_string,
    json_extract_string(value, '$.value.intValue') AS attr_int,
    json_extract(value, '$.value.doubleValue') AS attr_double
  FROM span_filter, json_each(coalesce(attrs_json, '[]'::JSON))
),
extracted AS (
  SELECT
    trace_id,
    span_name,
    duration_ms,
    start_ms,
    max(status_code) AS status_code,
    COALESCE(
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
        'x-litellm-metadata-session-id'': ''([^'']+)''', 1
      ), ''),
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_metadata' THEN attr_string END),
        'session_id'': ''([^'']+)''', 1
      ), '')
    ) AS session_id,
    COALESCE(
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
        'x-litellm-metadata-request-id'': ''([^'']+)''', 1
      ), ''),
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_metadata' THEN attr_string END),
        'request_id'': ''([^'']+)''', 1
      ), '')
    ) AS request_id,
    COALESCE(
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
        'x-litellm-metadata-agent-id'': ''([^'']+)''', 1
      ), ''),
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_metadata' THEN attr_string END),
        'agent_id'': ''([^'']+)''', 1
      ), '')
    ) AS agent_id,
    max(CASE WHEN attr_key IN ('gen_ai.request.model', 'gen_ai.response.model', 'model') THEN attr_string END) AS model,
    max(CASE WHEN attr_key = 'gen_ai.cost.total_cost' THEN CAST(attr_double AS DOUBLE) END) AS cost,
    max(CASE WHEN attr_key = 'gen_ai.usage.input_tokens' THEN CAST(attr_int AS BIGINT) END) AS input_tokens,
    max(CASE WHEN attr_key = 'gen_ai.usage.output_tokens' THEN CAST(attr_int AS BIGINT) END) AS output_tokens,
    max(CASE WHEN attr_key = 'gen_ai.input.messages' THEN attr_string END) AS input_messages,
    max(CASE WHEN attr_key = 'gen_ai.output.messages' THEN attr_string END) AS output_messages
  FROM attrs
  GROUP BY trace_id, span_name, duration_ms, start_ms
)
`;
}

function buildFallbackHtml(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Session Timeline Explorer</title></head><body style="font-family: ui-sans-serif, system-ui; background:#0f111a; color:#e5e7eb; margin:0; padding:20px;"><h2 style="margin:0 0 8px;">Session Timeline Explorer</h2><p style="opacity:.8;">${message}</p></body></html>`;
}

function isOutputDisabled(filename) {
  const raw = String(process.env.AGENTIDE_DISABLED_CHARTS || '').trim();
  if (!raw) {
    return false;
  }
  const disabled = new Set(
    raw
      .split(',')
      .map((entry) => path.basename(entry.trim()).toLowerCase())
      .filter(Boolean),
  );
  return disabled.has(path.basename(filename).toLowerCase());
}

function hasJsonlFiles(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sessionHandle(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) {
    return 'unknown';
  }
  if (raw.length <= 16) {
    return raw;
  }
  return `${raw.slice(0, 8)}...${raw.slice(-6)}`;
}

function normalizeText(raw) {
  if (raw === null || raw === undefined) {
    return '';
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw);
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function safeJsonParse(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== 'string') {
    return raw;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractTextContent(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextContent(item))
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (typeof value === 'object') {
    const itemType = String(value.type || '').toLowerCase();
    if (itemType === 'thinking' || itemType === 'signature') {
      return '';
    }
    const parts = [];
    if (value.text !== undefined) {
      parts.push(extractTextContent(value.text));
    }
    if (value.content !== undefined) {
      parts.push(extractTextContent(value.content));
    }
    if (value.parts !== undefined) {
      parts.push(extractTextContent(value.parts));
    }
    if (value.input !== undefined) {
      parts.push(extractTextContent(value.input));
    }
    if (value.arguments !== undefined) {
      parts.push(extractTextContent(value.arguments));
    }
    return parts.filter(Boolean).join(' ').trim();
  }
  return String(value);
}

function truncateWords(text, maxWords) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return words.slice(0, maxWords).join(' ') + ' …';
}

function extractSnippetCandidatesFromRawString(raw) {
  const text = normalizeText(raw);
  if (!text) {
    return [];
  }

  const candidates = [];
  const patterns = [
    /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /"content"\s*:\s*"((?:\\.|[^"\\])*)"/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const rawValue = match[1];
      if (!rawValue) {
        continue;
      }
      try {
        const decoded = JSON.parse(`"${rawValue}"`);
        const normalized = String(decoded || '').replace(/\u0000/g, '').trim();
        if (normalized) {
          candidates.push(normalized);
        }
      } catch {
        // ignore malformed/truncated snippets
      }
    }
  }

  return candidates;
}

function buildPromptPreview(raw) {
  const parsed = safeJsonParse(raw);
  let entries = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
    entries = parsed.messages;
  }

  const snippets = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const content = entry.content ?? entry.parts ?? entry.text ?? entry.input;
    const text = extractTextContent(content).replace(/\u0000/g, '').trim();
    if (text) {
      snippets.push(text);
    }
  }

  const candidates = snippets.length > 0 ? snippets : extractSnippetCandidatesFromRawString(raw);
  const lastTwo = candidates.slice(-2).map((text) => truncateWords(text, 10));
  return lastTwo.join('\n').trim();
}

function makePromptField(raw, budget, fullTexts) {
  const base = makeTextField(raw, budget, fullTexts);
  if (!base) {
    return null;
  }

  const customPreview = buildPromptPreview(raw);
  if (!customPreview) {
    return base;
  }

  return {
    ...base,
    preview: customPreview,
    previewTruncated: true,
  };
}

function makeTextField(raw, budget, fullTexts) {
  const text = normalizeText(raw).replace(/\u0000/g, '').trim();
  if (!text) {
    return null;
  }

  const preview = text.slice(0, TEXT_PREVIEW_CHARS);
  const previewTruncated = text.length > TEXT_PREVIEW_CHARS;
  if (!previewTruncated) {
    return {
      preview,
      previewTruncated: false,
      originalLength: text.length,
    };
  }

  if (budget.remaining <= 0) {
    return {
      preview,
      previewTruncated: true,
      originalLength: text.length,
      fullUnavailable: true,
      fullUnavailableReason: 'budget',
    };
  }

  const alloc = Math.min(MAX_FULL_TEXT_CHARS_PER_FIELD, text.length, budget.remaining);
  if (alloc <= TEXT_PREVIEW_CHARS) {
    return {
      preview,
      previewTruncated: true,
      originalLength: text.length,
      fullUnavailable: true,
      fullUnavailableReason: 'budget',
    };
  }

  const full = text.slice(0, alloc);
  const fullKey = `t${budget.nextId++}`;
  fullTexts[fullKey] = full;
  budget.remaining -= full.length;
  return {
    preview,
    previewTruncated: true,
    originalLength: text.length,
    fullKey,
    fullLength: full.length,
    fullTruncated: full.length < text.length,
  };
}

function buildSessionSummariesSql(baseQuery) {
  return `${baseQuery}
SELECT
  session_id,
  COALESCE(MAX(agent_id), '') AS agent_id,
  ROUND(COALESCE(SUM(cost), 0), 6) AS total_cost,
  COUNT(*) AS llm_calls,
  COUNT(DISTINCT COALESCE(request_id, trace_id)) AS requests,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  ROUND(COALESCE(AVG(duration_ms), 0), 0) AS avg_latency_ms,
  MIN(start_ms) AS started_ms,
  MAX(start_ms) AS latest_ms
FROM extracted
WHERE session_id IS NOT NULL AND session_id != ''
GROUP BY session_id
ORDER BY latest_ms DESC
LIMIT ${SESSION_OVERSCAN};`;
}

function buildAllSessionsLlmSql(baseQuery) {
  return `${baseQuery}
, ranked AS (
  SELECT
    session_id,
    trace_id,
    COALESCE(request_id, '') AS request_id,
    start_ms,
    duration_ms,
    COALESCE(model, 'unknown') AS model,
    COALESCE(cost, 0) AS cost,
    COALESCE(input_tokens, 0) AS input_tokens,
    COALESCE(output_tokens, 0) AS output_tokens,
    COALESCE(input_messages, '') AS input_messages,
    COALESCE(output_messages, '') AS output_messages,
    COALESCE(status_code, 0) AS status_code,
    COALESCE(span_name, '') AS span_name,
    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY start_ms DESC) AS rn
  FROM extracted
  WHERE session_id IN (
    SELECT session_id FROM extracted
    WHERE session_id IS NOT NULL AND session_id != ''
    GROUP BY session_id ORDER BY MAX(start_ms) DESC LIMIT ${SESSION_OVERSCAN}
  )
)
SELECT
  session_id, trace_id, request_id, start_ms, duration_ms,
  model, cost, input_tokens, output_tokens,
  input_messages, output_messages, status_code, span_name
FROM ranked
WHERE rn <= ${MAX_LLM_ROWS_PER_SESSION}
ORDER BY session_id, start_ms ASC;`;
}

function loadSessionEventRows(sessionsDir, sessionId) {
  const sessionPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(sessionPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(sessionPath, 'utf8');
    if (!raw.trim()) {
      return [];
    }
    const rows = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        rows.push(parsed);
      } catch {
        // ignore malformed line
      }
    }
    rows.sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));
    return rows;
  } catch {
    return [];
  }
}

function buildToolAndEventData(sessionEventRows, budget, fullTexts) {
  const pendingTools = new Map();
  const toolCalls = [];
  const turnEvents = [];
  const errorEvents = [];

  let syntheticToolCounter = 0;
  for (const row of sessionEventRows) {
    const eventType = String(row.event_type || '').trim();
    const payload = row && typeof row.payload === 'object' ? row.payload : {};
    const requestId = String(row.request_id || '').trim() || '(unknown)';
    const timestamp = toNumber(row.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      continue;
    }

    if (eventType === 'turn_start' || eventType === 'turn_end') {
      turnEvents.push({
        type: eventType,
        requestId,
        timestamp,
      });
      continue;
    }

    if (eventType === 'error') {
      const message = makeTextField(payload.message || payload.error || '', budget, fullTexts);
      errorEvents.push({
        type: 'error',
        requestId,
        timestamp,
        message,
      });
      continue;
    }

    if (eventType !== 'tool_start' && eventType !== 'tool_end') {
      continue;
    }

    const toolName = String(payload.toolName || '(unknown tool)').trim() || '(unknown tool)';
    const callIdRaw = String(payload.callId || '').trim();
    const callId = callIdRaw || `__synthetic_${requestId}_${toolName}_${syntheticToolCounter++}`;
    const key = `${requestId}::${callId}`;

    if (eventType === 'tool_start') {
      pendingTools.set(key, {
        requestId,
        callId,
        toolName,
        startTimestamp: timestamp,
        input: makeTextField(payload.inputPreview || payload.input || '', budget, fullTexts),
      });
      continue;
    }

    const started = pendingTools.get(key);
    const resultField = makeTextField(payload.resultPreview || payload.result || '', budget, fullTexts);
    const isError = payload.isError === true || payload.isError === 'true';
    if (started) {
      pendingTools.delete(key);
      toolCalls.push({
        type: 'tool',
        requestId: started.requestId,
        callId: started.callId,
        toolName: started.toolName,
        startTimestamp: started.startTimestamp,
        endTimestamp: timestamp,
        durationMs: Math.max(0, timestamp - started.startTimestamp),
        isError,
        input: started.input,
        result: resultField,
      });
    } else {
      toolCalls.push({
        type: 'tool',
        requestId,
        callId,
        toolName,
        startTimestamp: timestamp,
        endTimestamp: timestamp,
        durationMs: null,
        isError,
        input: null,
        result: resultField,
        orphanedEnd: true,
      });
    }
  }

  for (const pending of pendingTools.values()) {
    toolCalls.push({
      type: 'tool',
      requestId: pending.requestId,
      callId: pending.callId,
      toolName: pending.toolName,
      startTimestamp: pending.startTimestamp,
      endTimestamp: null,
      durationMs: null,
      isError: false,
      input: pending.input,
      result: null,
      incomplete: true,
    });
  }

  toolCalls.sort((a, b) => toNumber(a.startTimestamp) - toNumber(b.startTimestamp));
  turnEvents.sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));
  errorEvents.sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));

  const trimmedToolCalls = toolCalls.length > MAX_TOOL_CALLS_PER_SESSION
    ? toolCalls.slice(-MAX_TOOL_CALLS_PER_SESSION)
    : toolCalls;
  const trimmedTurnEvents = turnEvents.length > MAX_TURN_EVENTS_PER_SESSION
    ? turnEvents.slice(-MAX_TURN_EVENTS_PER_SESSION)
    : turnEvents;
  const trimmedErrorEvents = errorEvents.length > MAX_ERROR_EVENTS_PER_SESSION
    ? errorEvents.slice(-MAX_ERROR_EVENTS_PER_SESSION)
    : errorEvents;

  return {
    toolCalls: trimmedToolCalls,
    turnEvents: trimmedTurnEvents,
    errorEvents: trimmedErrorEvents,
    truncated: {
      toolCallsDropped: Math.max(0, toolCalls.length - trimmedToolCalls.length),
      turnEventsDropped: Math.max(0, turnEvents.length - trimmedTurnEvents.length),
      errorEventsDropped: Math.max(0, errorEvents.length - trimmedErrorEvents.length),
    },
  };
}

function buildRequestGroups(llmRows, toolCalls, turnEvents, errorEvents, budget, fullTexts) {
  const groupMap = new Map();
  const ensureGroup = (requestId) => {
    const normalized = String(requestId || '').trim() || '(unknown)';
    if (!groupMap.has(normalized)) {
      groupMap.set(normalized, {
        requestId: normalized,
        llmCalls: [],
        orphanTools: [],
        turnEvents: [],
        errorEvents: [],
        startTimestamp: null,
        endTimestamp: null,
      });
    }
    return groupMap.get(normalized);
  };

  for (const row of llmRows) {
    const requestId = String(row.request_id || '').trim() || '(unknown)';
    const group = ensureGroup(requestId);
    const timestamp = toNumber(row.start_ms);
    const durationMs = toNumber(row.duration_ms);
    const isError = toNumber(row.status_code) === 2 || String(row.span_name || '').includes('Failed');
    const llmCall = {
      type: 'llm',
      traceId: String(row.trace_id || ''),
      requestId,
      timestamp,
      durationMs,
      model: String(row.model || 'unknown'),
      cost: toNumber(row.cost),
      inputTokens: Math.max(0, Math.round(toNumber(row.input_tokens))),
      outputTokens: Math.max(0, Math.round(toNumber(row.output_tokens))),
      isError,
      prompt: makePromptField(row.input_messages, budget, fullTexts),
      completion: makeTextField(row.output_messages, budget, fullTexts),
      tools: [],
    };
    group.llmCalls.push(llmCall);
    group.startTimestamp = group.startTimestamp === null ? timestamp : Math.min(group.startTimestamp, timestamp);
    group.endTimestamp = group.endTimestamp === null
      ? timestamp + durationMs
      : Math.max(group.endTimestamp, timestamp + durationMs);
  }

  for (const call of toolCalls) {
    const group = ensureGroup(call.requestId);
    const targetCall = [...group.llmCalls]
      .reverse()
      .find((llm) => llm.timestamp <= toNumber(call.startTimestamp));
    if (targetCall) {
      targetCall.tools.push(call);
    } else {
      group.orphanTools.push(call);
    }
    const start = toNumber(call.startTimestamp);
    const end = call.endTimestamp === null ? start : toNumber(call.endTimestamp);
    group.startTimestamp = group.startTimestamp === null ? start : Math.min(group.startTimestamp, start);
    group.endTimestamp = group.endTimestamp === null ? end : Math.max(group.endTimestamp, end);
  }

  for (const marker of turnEvents) {
    const group = ensureGroup(marker.requestId);
    group.turnEvents.push(marker);
    const ts = toNumber(marker.timestamp);
    group.startTimestamp = group.startTimestamp === null ? ts : Math.min(group.startTimestamp, ts);
    group.endTimestamp = group.endTimestamp === null ? ts : Math.max(group.endTimestamp, ts);
  }

  for (const event of errorEvents) {
    const group = ensureGroup(event.requestId);
    group.errorEvents.push(event);
    const ts = toNumber(event.timestamp);
    group.startTimestamp = group.startTimestamp === null ? ts : Math.min(group.startTimestamp, ts);
    group.endTimestamp = group.endTimestamp === null ? ts : Math.max(group.endTimestamp, ts);
  }

  const groups = [...groupMap.values()]
    .map((group) => {
      group.llmCalls.sort((a, b) => a.timestamp - b.timestamp);
      for (const llm of group.llmCalls) {
        llm.tools.sort((a, b) => toNumber(a.startTimestamp) - toNumber(b.startTimestamp));
      }
      group.orphanTools.sort((a, b) => toNumber(a.startTimestamp) - toNumber(b.startTimestamp));
      group.turnEvents.sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));
      group.errorEvents.sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));
      return group;
    })
    .sort((a, b) => toNumber(a.startTimestamp) - toNumber(b.startTimestamp));

  return groups;
}

function buildSessionDetails(llmRowsBySession, sessionsDir, activeSessionId, summaryRows) {
  const budget = { remaining: GLOBAL_FULL_TEXT_BUDGET, nextId: 1 };
  const fullTexts = {};

  const normalizedActive = String(activeSessionId || '').trim();
  const orderedSummaries = [...summaryRows];
  if (normalizedActive) {
    const idx = orderedSummaries.findIndex((s) => String(s.session_id || '').trim() === normalizedActive);
    if (idx > 0) {
      const [active] = orderedSummaries.splice(idx, 1);
      orderedSummaries.unshift(active);
    }
  }

  const selected = orderedSummaries.slice(0, SESSION_LIMIT);
  const sessions = [];
  for (const row of selected) {
    const sessionId = String(row.session_id || '').trim();
    if (!sessionId) {
      continue;
    }
    const llmRows = llmRowsBySession.get(sessionId) || [];
    const sessionEventRows = loadSessionEventRows(sessionsDir, sessionId);
    const toolBundle = buildToolAndEventData(sessionEventRows, budget, fullTexts);
    const requestGroups = buildRequestGroups(
      llmRows,
      toolBundle.toolCalls,
      toolBundle.turnEvents,
      toolBundle.errorEvents,
      budget,
      fullTexts,
    );
    const isActive = normalizedActive ? sessionId === normalizedActive : sessions.length === 0;

    sessions.push({
      sessionId,
      handle: sessionHandle(sessionId),
      isActive,
      agentId: String(row.agent_id || ''),
      totalCost: toNumber(row.total_cost),
      llmCalls: Math.max(0, Math.round(toNumber(row.llm_calls))),
      requestCount: Math.max(0, Math.round(toNumber(row.requests))),
      inputTokens: Math.max(0, Math.round(toNumber(row.input_tokens))),
      outputTokens: Math.max(0, Math.round(toNumber(row.output_tokens))),
      avgLatencyMs: Math.max(0, Math.round(toNumber(row.avg_latency_ms))),
      startedMs: Math.round(toNumber(row.started_ms)),
      latestMs: Math.round(toNumber(row.latest_ms)),
      requests: requestGroups,
      timelineStats: {
        toolCalls: toolBundle.toolCalls.length,
        turnEvents: toolBundle.turnEvents.length,
        errorEvents: toolBundle.errorEvents.length,
        llmRows: llmRows.length,
        truncated: {
          llmRowsDropped: llmRows.length >= MAX_LLM_ROWS_PER_SESSION,
          ...toolBundle.truncated,
        },
      },
    });
  }

  return { sessions, fullTexts };
}

function buildHtml(payload) {
  const safeJson = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Session Timeline Explorer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #10192d;
      --panel-soft: #16233c;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --border: #1f2d44;
      --accent: #3b82f6;
      --good: #10b981;
      --warn: #f59e0b;
      --bad: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .root {
      display: grid;
      grid-template-columns: minmax(240px, 300px) 1fr;
      min-height: 96vh;
    }
    .sidebar {
      border-right: 1px solid var(--border);
      background: #0e172a;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .title {
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.1px;
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid #24467b;
      background: #132341;
      color: #93c5fd;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      white-space: nowrap;
    }
    .search {
      width: 100%;
      background: #0a1324;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 8px 10px;
      outline: none;
    }
    .search:focus { border-color: var(--accent); }
    .session-list {
      display: grid;
      gap: 8px;
      overflow: auto;
      padding-right: 2px;
      min-height: 120px;
    }
    .session-item {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 10px;
      padding: 9px;
      cursor: pointer;
      transition: border-color .12s ease, background .12s ease;
    }
    .session-item:hover {
      border-color: #34588c;
      background: #152440;
    }
    .session-item.active {
      border-color: var(--accent);
      background: #152a4a;
    }
    .session-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }
    .session-id {
      font-weight: 600;
      max-width: 75%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .live-badge {
      border: 1px solid #14532d;
      color: #86efac;
      background: #052e16;
      font-size: 10px;
      border-radius: 999px;
      padding: 1px 7px;
      font-weight: 700;
    }
    .session-meta {
      color: var(--muted);
      font-size: 11px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .main {
      padding: 14px;
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .session-header {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 12px;
      padding: 12px;
      display: grid;
      gap: 8px;
    }
    .session-topline {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .session-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      min-width: 0;
    }
    .session-title code {
      background: #0b1730;
      border: 1px solid #22375a;
      padding: 2px 6px;
      border-radius: 6px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .copy-btn {
      background: #10203a;
      border: 1px solid #28446f;
      color: #bfdbfe;
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 11px;
      cursor: pointer;
    }
    .copy-btn:hover { border-color: #3b82f6; }
    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(100px, 1fr));
      gap: 8px;
    }
    .stat {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #0f1b30;
      padding: 8px;
      min-width: 0;
    }
    .stat-label {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 3px;
    }
    .stat-value {
      font-weight: 700;
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .warn-line {
      color: #fcd34d;
      font-size: 11px;
      border: 1px solid rgba(245, 158, 11, 0.45);
      background: rgba(146, 64, 14, 0.35);
      border-radius: 8px;
      padding: 6px 8px;
      display: none;
    }
    .session-growth {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #0d172b;
      padding: 8px;
      display: grid;
      gap: 7px;
    }
    .session-growth-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .session-growth-title {
      font-size: 12px;
      font-weight: 700;
      color: #bfdbfe;
    }
    .session-growth-hint {
      color: var(--muted);
      font-size: 10px;
    }
    .session-growth svg {
      width: 100%;
      height: 210px;
      display: block;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.26);
      background: #081325;
    }
    .growth-meta {
      color: var(--muted);
      font-size: 11px;
      min-height: 16px;
      word-break: break-word;
    }
    .timeline {
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .request {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: #0f182b;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .request.focused {
      border-color: #60a5fa;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
    }
    .request-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      padding-bottom: 6px;
      margin-bottom: 2px;
    }
    .request-id {
      font-weight: 600;
      color: #bfdbfe;
    }
    .request-meta {
      color: var(--muted);
      font-size: 11px;
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
    }
    .llm-card {
      border: 1px solid #25406a;
      border-radius: 10px;
      background: #10203a;
      padding: 9px;
      display: grid;
      gap: 7px;
    }
    .llm-card.focused {
      border-color: #60a5fa;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
    }
    .llm-card.error {
      border-color: rgba(239, 68, 68, 0.7);
      background: rgba(69, 19, 19, 0.45);
    }
    .llm-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .model-pill {
      border: 1px solid #31598e;
      border-radius: 999px;
      background: #142949;
      color: #dbeafe;
      padding: 2px 8px;
      font-size: 11px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .llm-metrics {
      color: var(--muted);
      font-size: 11px;
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
    }
    .error-pill {
      border: 1px solid #7f1d1d;
      background: #450a0a;
      color: #fca5a5;
      border-radius: 999px;
      font-size: 10px;
      padding: 2px 7px;
      font-weight: 700;
    }
    .tool-list {
      display: grid;
      gap: 6px;
      margin-left: 14px;
      border-left: 2px solid rgba(148, 163, 184, 0.2);
      padding-left: 10px;
    }
    .tool-item {
      border: 1px solid var(--border);
      background: var(--panel-soft);
      border-radius: 8px;
      padding: 7px;
      display: grid;
      gap: 5px;
    }
    .tool-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .tool-name { font-weight: 600; color: #cbd5e1; }
    .tool-meta {
      color: var(--muted);
      font-size: 11px;
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
    }
    .tool-status {
      border-radius: 999px;
      font-size: 10px;
      padding: 1px 7px;
      font-weight: 700;
    }
    .tool-status.ok {
      color: #86efac;
      border: 1px solid #14532d;
      background: #052e16;
    }
    .tool-status.err {
      color: #fecaca;
      border: 1px solid #7f1d1d;
      background: #450a0a;
    }
    .tool-status.running {
      color: #fde68a;
      border: 1px solid #78350f;
      background: #422006;
    }
    .text-block {
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 8px;
      background: #0b1628;
      padding: 7px;
      display: grid;
      gap: 6px;
    }
    .text-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      color: #cbd5e1;
      font-size: 11px;
    }
    .text-lens {
      color: var(--muted);
      font-size: 10px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      max-height: 240px;
      overflow: auto;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: #070f1d;
      color: #dbeafe;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.42;
    }
    pre.full {
      max-height: 460px;
      border-color: rgba(59, 130, 246, 0.45);
      background: #050d1a;
      margin-top: 2px;
    }
    .toggle-btn {
      justify-self: start;
      font-size: 11px;
      border-radius: 7px;
      border: 1px solid #2c4f84;
      background: #112645;
      color: #bfdbfe;
      padding: 4px 9px;
      cursor: pointer;
    }
    .toggle-btn:hover { border-color: #3b82f6; }
    .note {
      color: #fcd34d;
      font-size: 10px;
    }
    .marker-row,
    .error-row {
      border: 1px dashed rgba(148, 163, 184, 0.4);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      color: #cbd5e1;
      background: rgba(15, 23, 42, 0.55);
    }
    .error-row {
      border-color: rgba(239, 68, 68, 0.55);
      background: rgba(69, 10, 10, 0.35);
      color: #fecaca;
    }
    .empty {
      border: 1px dashed var(--border);
      border-radius: 10px;
      color: var(--muted);
      padding: 16px;
      text-align: center;
      background: #0d172b;
    }
    .meta-line {
      color: var(--muted);
      font-size: 11px;
    }
    @media (max-width: 960px) {
      .root { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--border); max-height: 38vh; }
      .stats { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
      .session-growth svg { height: 190px; }
    }
  </style>
</head>
<body>
  <div class="root">
    <aside class="sidebar">
      <div class="title-row">
        <div class="title">Session Timeline Explorer</div>
        <div class="pill">Interactive HTML</div>
      </div>
      <input id="session-search" class="search" placeholder="Search session id / agent" />
      <div id="session-list" class="session-list"></div>
      <div class="meta-line" id="footer-meta"></div>
    </aside>
    <main class="main">
      <section class="session-header">
        <div class="session-topline">
          <div id="session-title" class="session-title"></div>
          <button id="copy-session-btn" class="copy-btn" type="button">Copy session id</button>
        </div>
        <div class="stats">
          <div class="stat"><div class="stat-label">Cost</div><div class="stat-value" id="stat-cost">-</div></div>
          <div class="stat"><div class="stat-label">LLM calls</div><div class="stat-value" id="stat-llm">-</div></div>
          <div class="stat"><div class="stat-label">Requests</div><div class="stat-value" id="stat-requests">-</div></div>
          <div class="stat"><div class="stat-label">Tokens</div><div class="stat-value" id="stat-tokens">-</div></div>
          <div class="stat"><div class="stat-label">Avg latency</div><div class="stat-value" id="stat-latency">-</div></div>
        </div>
        <div class="session-growth">
          <div class="session-growth-head">
            <div class="session-growth-title">Cumulative Token/Cost by Turn</div>
            <div class="session-growth-hint">Click a point to jump to its request in timeline</div>
          </div>
          <svg id="session-growth-chart" role="img" aria-label="Cumulative token and cost chart"></svg>
          <div id="growth-meta" class="growth-meta"></div>
        </div>
        <div id="warn-line" class="warn-line"></div>
      </section>
      <section id="timeline" class="timeline"></section>
    </main>
  </div>
  <script>
    const data = ${safeJson};
    const listEl = document.getElementById('session-list');
    const timelineEl = document.getElementById('timeline');
    const titleEl = document.getElementById('session-title');
    const footerMetaEl = document.getElementById('footer-meta');
    const warnLineEl = document.getElementById('warn-line');
    const searchEl = document.getElementById('session-search');
    const copyBtn = document.getElementById('copy-session-btn');
    const statCostEl = document.getElementById('stat-cost');
    const statLlmEl = document.getElementById('stat-llm');
    const statRequestsEl = document.getElementById('stat-requests');
    const statTokensEl = document.getElementById('stat-tokens');
    const statLatencyEl = document.getElementById('stat-latency');
    const growthChartEl = document.getElementById('session-growth-chart');
    const growthMetaEl = document.getElementById('growth-meta');

    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const fullTexts = data.fullTexts || {};
    const clipboardPending = new Map();
    const state = {
      search: '',
      selectedId: (() => {
        const active = sessions.find((item) => item && item.isActive);
        return active ? active.sessionId : (sessions[0] ? sessions[0].sessionId : '');
      })(),
      selectedGrowthSessionId: '',
      selectedGrowthIndex: -1,
    };

    const esc = (v) => String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

    const fmtMoney = (n) => '$' + Number(n || 0).toFixed(4);
    const fmtNum = (n) => Number(n || 0).toLocaleString();
    const toNum = (n) => {
      const value = Number(n || 0);
      return Number.isFinite(value) ? value : 0;
    };
    const fmtDuration = (ms) => {
      const value = Number(ms || 0);
      if (!Number.isFinite(value) || value <= 0) return '-';
      if (value < 1000) return Math.round(value) + 'ms';
      return (value / 1000).toFixed(2) + 's';
    };
    const fmtWhen = (ms) => {
      const value = Number(ms || 0);
      if (!Number.isFinite(value) || value <= 0) return '-';
      const date = new Date(value);
      return date.toLocaleString();
    };
    const fmtAgo = (ms) => {
      const value = Number(ms || 0);
      if (!Number.isFinite(value) || value <= 0) return '-';
      const deltaSec = Math.floor((Date.now() - value) / 1000);
      if (deltaSec < 60) return 'just now';
      if (deltaSec < 3600) return Math.floor(deltaSec / 60) + 'm ago';
      if (deltaSec < 86400) return Math.floor(deltaSec / 3600) + 'h ago';
      return Math.floor(deltaSec / 86400) + 'd ago';
    };

    const postCopySessionId = (sessionId) => {
      if (!sessionId) return;
      window.parent.postMessage({
        source: 'agentide-wow-widget',
        type: 'copySessionId',
        sessionId,
      }, '*');
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy session id';
      }, 1200);
    };

    const requestClipboardText = () => new Promise((resolve) => {
      const requestId = 'clip-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        clipboardPending.delete(requestId);
        resolve('');
      }, 1500);
      clipboardPending.set(requestId, { resolve, timer });
      window.parent.postMessage({
        source: 'agentide-wow-widget',
        type: 'requestClipboardText',
        requestId,
      }, '*');
    });

    window.addEventListener('message', (event) => {
      const payload = event.data;
      if (!payload || payload.source !== 'agentide-panel' || payload.type !== 'clipboardText') {
        return;
      }
      const entry = clipboardPending.get(payload.requestId);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      clipboardPending.delete(payload.requestId);
      entry.resolve(typeof payload.text === 'string' ? payload.text : '');
    });

    const insertAtCursor = (input, text) => {
      const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
      const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : input.value.length;
      const before = input.value.slice(0, start);
      const after = input.value.slice(end);
      input.value = before + text + after;
      const caret = start + text.length;
      input.selectionStart = caret;
      input.selectionEnd = caret;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    searchEl?.addEventListener('keydown', async (event) => {
      if (event.defaultPrevented) {
        return;
      }
      const isPasteShortcut = (event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'v';
      if (!isPasteShortcut) {
        return;
      }
      event.preventDefault();
      const text = await requestClipboardText();
      if (!text) {
        return;
      }
      insertAtCursor(searchEl, text);
    });

    searchEl?.addEventListener('paste', async (event) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.clipboardData?.getData('text')) {
        return;
      }
      event.preventDefault();
      const text = await requestClipboardText();
      if (!text) {
        return;
      }
      insertAtCursor(searchEl, text);
    });

    function getFilteredSessions() {
      const query = state.search.trim().toLowerCase();
      if (!query) return sessions;
      return sessions.filter((session) => {
        const sid = String(session.sessionId || '').toLowerCase();
        const agent = String(session.agentId || '').toLowerCase();
        return sid.includes(query) || agent.includes(query);
      });
    }

    function renderSessionList() {
      const filtered = getFilteredSessions();
      if (filtered.length === 0) {
        listEl.innerHTML = '<div class="empty">No matching sessions.</div>';
        return;
      }
      listEl.innerHTML = filtered.map((session) => {
        const activeClass = session.sessionId === state.selectedId ? ' active' : '';
        const liveBadge = session.isActive ? '<span class="live-badge">LIVE</span>' : '';
        return '<button type="button" class="session-item' + activeClass + '" data-session-id="' + esc(session.sessionId) + '">' +
          '<div class="session-head">' +
            '<div class="session-id" title="' + esc(session.sessionId) + '">' + esc(session.handle || session.sessionId) + '</div>' +
            liveBadge +
          '</div>' +
          '<div class="session-meta">' +
            '<span>' + fmtMoney(session.totalCost) + '</span>' +
            '<span>' + fmtNum(session.llmCalls) + ' LLM</span>' +
            '<span>' + fmtNum(session.requestCount) + ' req</span>' +
            '<span>' + esc(fmtAgo(session.latestMs)) + '</span>' +
          '</div>' +
        '</button>';
      }).join('');

      listEl.querySelectorAll('.session-item').forEach((item) => {
        item.addEventListener('click', () => {
          const sid = item.getAttribute('data-session-id') || '';
          if (!sid) return;
          state.selectedId = sid;
          render();
        });
      });
    }

    function renderTextBlock(label, field, prefix) {
      if (!field || !field.preview) return '';
      const preview = esc(field.preview + (field.previewTruncated ? '\\n... (preview)' : ''));
      const lens = field.originalLength ? fmtNum(field.originalLength) + ' chars' : '';
      const toggleButton = field.fullKey
        ? '<button type="button" class="toggle-btn" data-full-key="' + esc(field.fullKey) + '" data-full-target="' + esc(prefix) + '">Show full</button>'
        : '';
      const fullPre = field.fullKey
        ? '<pre id="' + esc(prefix) + '" class="full" hidden></pre>'
        : '';
      const note = field.fullUnavailable
        ? '<div class="note">Full text omitted to keep dashboard responsive.</div>'
        : (field.fullTruncated ? '<div class="note">Full text clipped for dashboard size.</div>' : '');
      return '<div class="text-block">' +
        '<div class="text-head"><span>' + esc(label) + '</span><span class="text-lens">' + esc(lens) + '</span></div>' +
        '<pre>' + preview + '</pre>' +
        toggleButton +
        fullPre +
        note +
      '</div>';
    }

    function requestDomId(requestId, index) {
      const normalized = String(requestId || 'request')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return 'request-' + (normalized || 'item') + '-' + String(index);
    }

    function llmDomId(requestId, requestIndex, llmIndex) {
      const normalized = String(requestId || 'request')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return 'llm-' + (normalized || 'item') + '-' + String(requestIndex) + '-' + String(llmIndex);
    }

    function renderTool(tool, requestId, idx) {
      const statusClass = tool.incomplete ? 'running' : (tool.isError ? 'err' : 'ok');
      const statusText = tool.incomplete ? 'RUNNING' : (tool.isError ? 'ERROR' : 'OK');
      const duration = tool.durationMs === null ? '-' : fmtDuration(tool.durationMs);
      const inputBlock = renderTextBlock('Input', tool.input, requestId + '-tool-' + idx + '-input');
      const resultBlock = renderTextBlock('Result', tool.result, requestId + '-tool-' + idx + '-result');
      return '<div class="tool-item">' +
        '<div class="tool-head">' +
          '<div class="tool-name">' + esc(tool.toolName || '(tool)') + '</div>' +
          '<span class="tool-status ' + statusClass + '">' + statusText + '</span>' +
        '</div>' +
        '<div class="tool-meta">' +
          '<span>' + esc(duration) + '</span>' +
          '<span>' + esc(fmtWhen(tool.startTimestamp)) + '</span>' +
          '<span>' + esc(tool.callId || '') + '</span>' +
        '</div>' +
        inputBlock +
        resultBlock +
      '</div>';
    }

    function renderLlm(llm, requestId, requestRowIndex, llmIdx) {
      const llmClass = llm.isError ? 'llm-card error' : 'llm-card';
      const cardId = llmDomId(requestId, requestRowIndex, llmIdx);
      const errorPill = llm.isError ? '<span class="error-pill">ERROR</span>' : '';
      const promptBlock = renderTextBlock('Prompt', llm.prompt, requestId + '-llm-' + llmIdx + '-prompt');
      const completionBlock = renderTextBlock('Completion', llm.completion, requestId + '-llm-' + llmIdx + '-completion');
      const tools = Array.isArray(llm.tools) ? llm.tools : [];
      const toolsHtml = tools.length > 0
        ? '<div class="tool-list">' + tools.map((tool, idx) => renderTool(tool, requestId + '-llm-' + llmIdx, idx)).join('') + '</div>'
        : '';
      return '<div id="' + esc(cardId) + '" class="' + llmClass + '" data-llm-index="' + String(llmIdx) + '">' +
        '<div class="llm-head">' +
          '<div class="model-pill" title="' + esc(llm.model || 'unknown') + '">' + esc(llm.model || 'unknown') + '</div>' +
          errorPill +
        '</div>' +
        '<div class="llm-metrics">' +
          '<span>' + fmtMoney(llm.cost) + '</span>' +
          '<span>' + esc(fmtDuration(llm.durationMs)) + '</span>' +
          '<span>in ' + fmtNum(llm.inputTokens) + '</span>' +
          '<span>out ' + fmtNum(llm.outputTokens) + '</span>' +
          '<span>' + esc(fmtWhen(llm.timestamp)) + '</span>' +
        '</div>' +
        promptBlock +
        completionBlock +
        toolsHtml +
      '</div>';
    }

    function renderRequest(request, index) {
      const llmCalls = Array.isArray(request.llmCalls) ? request.llmCalls : [];
      const orphanTools = Array.isArray(request.orphanTools) ? request.orphanTools : [];
      const turnEvents = Array.isArray(request.turnEvents) ? request.turnEvents : [];
      const errorEvents = Array.isArray(request.errorEvents) ? request.errorEvents : [];
      const requestId = String(request.requestId || '(unknown request)');
      const domId = requestDomId(requestId, index);

      const llmHtml = llmCalls
        .map((llm, idx) => renderLlm(llm, request.requestId || 'request-' + index, index, idx))
        .join('');
      const orphanHtml = orphanTools.length > 0
        ? '<div class="tool-list">' + orphanTools.map((tool, idx) => renderTool(tool, request.requestId || 'request-' + index, idx)).join('') + '</div>'
        : '';
      const turnsHtml = turnEvents.map((event) =>
        '<div class="marker-row">' + esc(event.type === 'turn_start' ? 'Turn start' : 'Turn end') + ' · ' + esc(fmtWhen(event.timestamp)) + '</div>'
      ).join('');
      const errorsHtml = errorEvents.map((event, idx) => {
        const msg = event.message ? renderTextBlock('Error', event.message, (request.requestId || 'request-' + index) + '-err-' + idx) : '';
        return '<div class="error-row">Error event · ' + esc(fmtWhen(event.timestamp)) + '</div>' + msg;
      }).join('');

      return '<article id="' + esc(domId) + '" class="request" data-request-id="' + esc(requestId) + '" data-request-index="' + String(index) + '">' +
        '<div class="request-head">' +
          '<div class="request-id" title="' + esc(request.requestId || '(unknown)') + '">' + esc(requestId) + '</div>' +
          '<div class="request-meta">' +
            '<span>' + fmtNum(llmCalls.length) + ' LLM</span>' +
            '<span>' + fmtNum(orphanTools.length + llmCalls.reduce((acc, llm) => acc + (Array.isArray(llm.tools) ? llm.tools.length : 0), 0)) + ' tools</span>' +
            '<span>' + esc(fmtWhen(request.startTimestamp)) + '</span>' +
          '</div>' +
        '</div>' +
        turnsHtml +
        errorsHtml +
        llmHtml +
        orphanHtml +
      '</article>';
    }

    function median(values) {
      if (!values.length) {
        return 0;
      }
      const sorted = [...values].sort((a, b) => a - b);
      const half = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) {
        return (sorted[half - 1] + sorted[half]) / 2;
      }
      return sorted[half];
    }

    function buildGrowthPoints(requestRows) {
      const points = [];
      let cumulativeCost = 0;
      let cumulativeTokens = 0;
      let turn = 0;

      requestRows.forEach((request, requestRowIndex) => {
        const requestId = String(request.requestId || '(unknown request)');
        const llmCalls = Array.isArray(request.llmCalls) ? request.llmCalls : [];
        llmCalls.forEach((llm, llmIndex) => {
          const deltaCost = toNum(llm.cost);
          const deltaTokens = Math.max(0, Math.round(toNum(llm.inputTokens) + toNum(llm.outputTokens)));
          cumulativeCost += deltaCost;
          cumulativeTokens += deltaTokens;
          turn += 1;
          points.push({
            turn,
            requestId,
            requestRowIndex,
            llmIndex,
            llmCardId: llmDomId(requestId, requestRowIndex, llmIndex),
            model: String(llm.model || 'unknown'),
            timestamp: toNum(llm.timestamp),
            deltaCost,
            deltaTokens,
            cumulativeCost: Number(cumulativeCost.toFixed(6)),
            cumulativeTokens,
          });
        });
      });

      const tokenM = median(points.map((point) => point.deltaTokens).filter((v) => v > 0));
      const costM = median(points.map((point) => point.deltaCost).filter((v) => v > 0));
      const tokenSpikeThreshold = tokenM > 0 ? tokenM * 2.2 : 0;
      const costSpikeThreshold = costM > 0 ? costM * 2.2 : 0;
      points.forEach((point) => {
        point.isSpike = (tokenSpikeThreshold > 0 && point.deltaTokens >= tokenSpikeThreshold)
          || (costSpikeThreshold > 0 && point.deltaCost >= costSpikeThreshold);
      });
      return points;
    }

    function jumpToTurn(point) {
      if (!point) return;
      const llmTarget = point.llmCardId ? document.getElementById(point.llmCardId) : null;
      if (llmTarget) {
        llmTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        llmTarget.classList.add('focused');
        const requestHost = llmTarget.closest('.request');
        requestHost?.classList.add('focused');
        setTimeout(() => {
          llmTarget.classList.remove('focused');
          requestHost?.classList.remove('focused');
        }, 1600);
        return;
      }

      const requestTarget = document.getElementById(requestDomId(point.requestId, point.requestRowIndex));
      if (!requestTarget) return;
      requestTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
      requestTarget.classList.add('focused');
      setTimeout(() => {
        requestTarget.classList.remove('focused');
      }, 1600);
    }

    function renderGrowthChart(session, requestRows) {
      if (!growthChartEl || !growthMetaEl) {
        return;
      }
      const points = buildGrowthPoints(requestRows);
      if (!points.length) {
        growthChartEl.innerHTML = '';
        growthMetaEl.textContent = 'No LLM turns available for cumulative chart.';
        return;
      }

      if (state.selectedGrowthSessionId !== session.sessionId) {
        state.selectedGrowthSessionId = session.sessionId;
        state.selectedGrowthIndex = points.length - 1;
      }
      if (state.selectedGrowthIndex < 0 || state.selectedGrowthIndex >= points.length) {
        state.selectedGrowthIndex = points.length - 1;
      }

      const width = Math.max(640, growthChartEl.clientWidth || 780);
      const height = Math.max(190, growthChartEl.clientHeight || 210);
      const margin = { top: 14, right: 58, bottom: 30, left: 58 };
      const innerWidth = Math.max(220, width - margin.left - margin.right);
      const innerHeight = Math.max(120, height - margin.top - margin.bottom);

      growthChartEl.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      growthChartEl.innerHTML = '';

      const maxTokens = Math.max(1, ...points.map((point) => point.cumulativeTokens));
      const maxCost = Math.max(0.000001, ...points.map((point) => point.cumulativeCost));
      const sx = (index) => margin.left + (index / Math.max(1, points.length - 1)) * innerWidth;
      const syTokens = (value) => margin.top + innerHeight - (toNum(value) / maxTokens) * innerHeight;
      const syCost = (value) => margin.top + innerHeight - (toNum(value) / maxCost) * innerHeight;
      const make = (name) => document.createElementNS('http://www.w3.org/2000/svg', name);
      const pathFor = (items) => {
        if (!items.length) return '';
        let d = 'M ' + items[0].x + ' ' + items[0].y;
        for (let i = 1; i < items.length; i++) {
          d += ' L ' + items[i].x + ' ' + items[i].y;
        }
        return d;
      };

      const bg = make('rect');
      bg.setAttribute('x', String(margin.left));
      bg.setAttribute('y', String(margin.top));
      bg.setAttribute('width', String(innerWidth));
      bg.setAttribute('height', String(innerHeight));
      bg.setAttribute('fill', '#081325');
      bg.setAttribute('stroke', '#243a59');
      growthChartEl.appendChild(bg);

      const tokenPoints = points.map((point, index) => ({ x: sx(index), y: syTokens(point.cumulativeTokens) }));
      const costPoints = points.map((point, index) => ({ x: sx(index), y: syCost(point.cumulativeCost) }));

      const tokenPath = make('path');
      tokenPath.setAttribute('d', pathFor(tokenPoints));
      tokenPath.setAttribute('fill', 'none');
      tokenPath.setAttribute('stroke', '#38bdf8');
      tokenPath.setAttribute('stroke-width', '2');
      growthChartEl.appendChild(tokenPath);

      const costPath = make('path');
      costPath.setAttribute('d', pathFor(costPoints));
      costPath.setAttribute('fill', 'none');
      costPath.setAttribute('stroke', '#f59e0b');
      costPath.setAttribute('stroke-width', '2');
      growthChartEl.appendChild(costPath);

      points.forEach((point, index) => {
        const x = sx(index);
        const selected = index === state.selectedGrowthIndex;
        const hit = make('rect');
        hit.setAttribute('x', String(x - 5));
        hit.setAttribute('y', String(margin.top));
        hit.setAttribute('width', '10');
        hit.setAttribute('height', String(innerHeight));
        hit.setAttribute('fill', 'transparent');
        hit.style.cursor = 'pointer';
        hit.addEventListener('click', () => {
          state.selectedGrowthIndex = index;
          renderGrowthChart(session, requestRows);
          jumpToTurn(point);
        });
        growthChartEl.appendChild(hit);

        const tokenDot = make('circle');
        tokenDot.setAttribute('cx', String(x));
        tokenDot.setAttribute('cy', String(syTokens(point.cumulativeTokens)));
        tokenDot.setAttribute('r', selected ? '3.8' : '2.6');
        tokenDot.setAttribute('fill', '#38bdf8');
        if (selected) {
          tokenDot.setAttribute('stroke', '#ffffff');
          tokenDot.setAttribute('stroke-width', '1.2');
        }
        growthChartEl.appendChild(tokenDot);

        const costDot = make('circle');
        costDot.setAttribute('cx', String(x));
        costDot.setAttribute('cy', String(syCost(point.cumulativeCost)));
        costDot.setAttribute('r', selected ? '3.6' : '2.4');
        costDot.setAttribute('fill', '#f59e0b');
        growthChartEl.appendChild(costDot);

        if (point.isSpike) {
          const spike = make('line');
          spike.setAttribute('x1', String(x));
          spike.setAttribute('y1', String(margin.top));
          spike.setAttribute('x2', String(x));
          spike.setAttribute('y2', String(margin.top + innerHeight));
          spike.setAttribute('stroke', '#ef4444');
          spike.setAttribute('stroke-dasharray', '2 4');
          spike.setAttribute('stroke-opacity', selected ? '0.8' : '0.35');
          growthChartEl.appendChild(spike);
        }
      });

      const selectedPoint = points[state.selectedGrowthIndex];
      const spikeHint = selectedPoint.isSpike ? ' · sudden change detected' : '';
      growthMetaEl.textContent =
        'Turn #' + selectedPoint.turn +
        ' · ' + selectedPoint.requestId +
        ' · model ' + selectedPoint.model +
        ' · +$' + toNum(selectedPoint.deltaCost).toFixed(4) +
        ' · +' + fmtNum(selectedPoint.deltaTokens) + ' tokens' +
        ' · cumulative ' + fmtMoney(selectedPoint.cumulativeCost) +
        ' / ' + fmtNum(selectedPoint.cumulativeTokens) + ' tokens' +
        spikeHint;
    }

    function renderSelectedSession() {
      const session = sessions.find((item) => item.sessionId === state.selectedId);
      if (!session) {
        titleEl.innerHTML = '<span>No session selected</span>';
        statCostEl.textContent = '-';
        statLlmEl.textContent = '-';
        statRequestsEl.textContent = '-';
        statTokensEl.textContent = '-';
        statLatencyEl.textContent = '-';
        warnLineEl.style.display = 'none';
        timelineEl.innerHTML = '<div class="empty">Select a session to inspect timeline details.</div>';
        if (growthChartEl) {
          growthChartEl.innerHTML = '';
        }
        if (growthMetaEl) {
          growthMetaEl.textContent = 'Select a session to inspect cumulative growth.';
        }
        copyBtn.disabled = true;
        return;
      }

      copyBtn.disabled = false;
      copyBtn.onclick = () => postCopySessionId(session.sessionId);
      titleEl.innerHTML = '<span>Session</span><code title="' + esc(session.sessionId) + '">' + esc(session.sessionId) + '</code>' +
        (session.isActive ? '<span class="live-badge">LIVE</span>' : '');

      statCostEl.textContent = fmtMoney(session.totalCost);
      statLlmEl.textContent = fmtNum(session.llmCalls);
      statRequestsEl.textContent = fmtNum(session.requestCount);
      statTokensEl.textContent = fmtNum((session.inputTokens || 0) + (session.outputTokens || 0));
      statLatencyEl.textContent = fmtDuration(session.avgLatencyMs);

      const trunc = session.timelineStats && session.timelineStats.truncated ? session.timelineStats.truncated : {};
      const warnings = [];
      if (trunc.llmRowsDropped) {
        warnings.push('LLM timeline capped at recent ' + ${String(MAX_LLM_ROWS_PER_SESSION)} + ' calls.');
      }
      if (trunc.toolCallsDropped > 0) {
        warnings.push(String(trunc.toolCallsDropped) + ' older tool calls hidden.');
      }
      if (trunc.turnEventsDropped > 0) {
        warnings.push(String(trunc.turnEventsDropped) + ' older turn markers hidden.');
      }
      if (trunc.errorEventsDropped > 0) {
        warnings.push(String(trunc.errorEventsDropped) + ' older error events hidden.');
      }

      if (warnings.length > 0) {
        warnLineEl.textContent = warnings.join(' ');
        warnLineEl.style.display = 'block';
      } else {
        warnLineEl.style.display = 'none';
      }

      const requestRows = Array.isArray(session.requests) ? session.requests : [];
      if (requestRows.length === 0) {
        timelineEl.innerHTML = '<div class="empty">No timeline events found for this session.</div>';
      } else {
        timelineEl.innerHTML = requestRows.map((request, idx) => renderRequest(request, idx)).join('');
      }
      renderGrowthChart(session, requestRows);
    }

    function wireFullTextToggles() {
      timelineEl.querySelectorAll('.toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.getAttribute('data-full-key') || '';
          const target = btn.getAttribute('data-full-target') || '';
          const fullEl = document.getElementById(target);
          if (!fullEl) return;
          if (fullEl.hidden) {
            if (!fullEl.dataset.loaded) {
              const content = typeof fullTexts[key] === 'string'
                ? fullTexts[key]
                : '(Full text not available in this view.)';
              fullEl.textContent = content;
              fullEl.dataset.loaded = '1';
            }
            fullEl.hidden = false;
            btn.textContent = 'Hide full';
            return;
          }
          fullEl.hidden = true;
          btn.textContent = 'Show full';
        });
      });
    }

    function renderFooterMeta() {
      footerMetaEl.textContent = sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ' loaded';
    }

    function render() {
      renderSessionList();
      renderSelectedSession();
      wireFullTextToggles();
      renderFooterMeta();
    }

    searchEl.addEventListener('input', () => {
      state.search = searchEl.value || '';
      renderSessionList();
    });

    render();
  </script>
</body>
</html>`;
}

function main() {
  const home = process.env.HOME || '';
  const tracesDir = process.env.AGENTIDE_TRACES_DIR || path.join(home, '.agent-hippo', 'analytics', 'traces');
  const sessionsDir = process.env.AGENTIDE_SESSIONS_DIR || path.join(home, '.agent-hippo', 'analytics', 'sessions');
  const chartDir = process.env.AGENTIDE_CHART_DIR || path.join(home, '.agent-hippo', 'analytics', 'views', 'global', '__all', '__all', 'charts');
  const outputPath = path.join(chartDir, 'session-timeline-widget.html');
  const activeSessionId = String(process.env.AGENTIDE_ACTIVE_SESSION_ID || '').trim();

  fs.mkdirSync(chartDir, { recursive: true });
  if (isOutputDisabled('session-timeline-widget.html')) {
    try {
      fs.unlinkSync(outputPath);
    } catch {
      // ignore missing file
    }
    return;
  }

  const duckdb = findDuckdb();
  if (!duckdb) {
    fs.writeFileSync(outputPath, buildFallbackHtml('DuckDB not found. Run Spotlight setup first.'), 'utf8');
    return;
  }

  const indexedDbPath = getIndexedDbPath(tracesDir);
  if (!indexedDbPath && !hasJsonlFiles(tracesDir)) {
    fs.writeFileSync(outputPath, buildFallbackHtml('No session trace data available yet.'), 'utf8');
    return;
  }

  const runQueries = (baseQuery, dbPath = '') => runBatchQueries(duckdb, [
    { name: 'summaries', sql: buildSessionSummariesSql(baseQuery) },
    { name: 'llmRows', sql: buildAllSessionsLlmSql(baseQuery) },
  ], dbPath);

  // Run against indexed DB first when available; fall back to JSONL if indexed query fails.
  let batch = runQueries(buildBaseQuery(tracesDir, Boolean(indexedDbPath)), indexedDbPath);
  if (indexedDbPath && batch.failed) {
    console.error('session-timeline-widget indexed query failed; falling back to JSONL parsing');
    batch = runQueries(buildBaseQuery(tracesDir, false));
  }

  const batchResults = batch.result;
  const summaryRows = batchResults.summaries;
  if (!summaryRows.length) {
    fs.writeFileSync(outputPath, buildFallbackHtml('No session trace data available yet.'), 'utf8');
    return;
  }

  // Build per-session LLM rows map (already ordered chronologically by the SQL query).
  const llmRowsBySession = new Map();
  for (const row of batchResults.llmRows) {
    const sid = String(row.session_id || '').trim();
    if (!sid) { continue; }
    if (!llmRowsBySession.has(sid)) { llmRowsBySession.set(sid, []); }
    llmRowsBySession.get(sid).push(row);
  }

  const { sessions, fullTexts } = buildSessionDetails(
    llmRowsBySession,
    sessionsDir,
    activeSessionId,
    summaryRows,
  );

  if (!sessions.length) {
    fs.writeFileSync(outputPath, buildFallbackHtml('No sessions available for timeline rendering.'), 'utf8');
    return;
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    activeSessionId: activeSessionId || null,
    limits: {
      sessionLimit: SESSION_LIMIT,
      maxLlmRowsPerSession: MAX_LLM_ROWS_PER_SESSION,
      maxToolCallsPerSession: MAX_TOOL_CALLS_PER_SESSION,
      textPreviewChars: TEXT_PREVIEW_CHARS,
    },
    sessions,
    fullTexts,
  };

  fs.writeFileSync(outputPath, buildHtml(payload), 'utf8');
}

main();
