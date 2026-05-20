#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findDuckdb } = require('./duckdbLocator');

const SESSION_LIMIT = 28;
const MAX_LLM_EVENTS_PER_SESSION = 220;
const MAX_TOOL_EVENTS_PER_SESSION = 260;
const MAX_SEQUENCE_RENDER = 36;
const MAX_MODELS_PER_SESSION = 14;
const MAX_TOOLS_PER_SESSION = 18;

function parseJsonArraysFromOutput(stdout) {
  const results = [];
  let depth = 0, start = -1;
  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i];
    if (c === '[') { if (depth === 0) start = i; depth++; }
    else if (c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { results.push(JSON.parse(stdout.slice(start, i + 1))); }
        catch { results.push([]); }
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
    maxBuffer: 30 * 1024 * 1024,
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
      maxBuffer: 30 * 1024 * 1024,
    });
    const arrays = parseJsonArraysFromOutput(stdout);
    const result = {};
    queries.forEach((q, i) => { result[q.name] = arrays[i] || []; });
    return { result, failed: false };
  } catch (err) {
    console.error(`session-comparison-widget batch query failed: ${err instanceof Error ? err.message : err}`);
    const fallbackResult = {};
    let anySuccess = false;
    for (const query of queries) {
      try {
        fallbackResult[query.name] = runSingleQuery(duckdbPath, query.sql, dbPath);
        anySuccess = true;
      } catch (singleErr) {
        console.error(`session-comparison-widget query fallback failed (${query.name}): ${singleErr instanceof Error ? singleErr.message : singleErr}`);
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

function hasJsonlFiles(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

function buildBaseQuery(tracesDir, useIndexed = false) {
  if (useIndexed) {
    return `
WITH extracted AS (
  SELECT
    trace_id,
    COALESCE(span_name, 'Received Proxy Server Request') AS span_name,
    COALESCE(duration_ms, 0) AS duration_ms,
    start_ms,
    0 AS status_code,
    session_id,
    '' AS request_id,
    COALESCE(agent_id, '') AS agent_id,
    '' AS agent_version,
    '' AS engine,
    COALESCE(model, 'unknown') AS model,
    COALESCE(cost, 0) AS cost,
    COALESCE(input_tokens, 0) AS input_tokens,
    COALESCE(output_tokens, 0) AS output_tokens
  FROM spans
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
    COALESCE(
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
        'x-litellm-metadata-agent-version'': ''([^'']+)''', 1
      ), ''),
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_metadata' THEN attr_string END),
        'agent_version'': ''([^'']+)''', 1
      ), '')
    ) AS agent_version,
    COALESCE(
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_custom_headers' THEN attr_string END),
        'x-litellm-metadata-engine'': ''([^'']+)''', 1
      ), ''),
      NULLIF(regexp_extract(
        max(CASE WHEN attr_key = 'metadata.requester_metadata' THEN attr_string END),
        'engine'': ''([^'']+)''', 1
      ), '')
    ) AS engine,
    max(CASE WHEN attr_key IN ('gen_ai.request.model', 'gen_ai.response.model', 'model') THEN attr_string END) AS model,
    max(CASE WHEN attr_key = 'gen_ai.cost.total_cost' THEN CAST(attr_double AS DOUBLE) END) AS cost,
    max(CASE WHEN attr_key = 'gen_ai.usage.input_tokens' THEN CAST(attr_int AS BIGINT) END) AS input_tokens,
    max(CASE WHEN attr_key = 'gen_ai.usage.output_tokens' THEN CAST(attr_int AS BIGINT) END) AS output_tokens
  FROM attrs
  GROUP BY trace_id, span_name, duration_ms, start_ms
)
`;
}

function buildFallbackHtml(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Session Comparison</title></head><body style="font-family: ui-sans-serif, system-ui; background:#0f111a; color:#e5e7eb; margin:0; padding:20px;"><h2 style="margin:0 0 8px;">Session Comparison</h2><p style="opacity:.8;">${message}</p></body></html>`;
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

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sessionHandle(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) {
    return 'unknown';
  }
  if (raw.length <= 20) {
    return raw;
  }
  return `${raw.slice(0, 8)}...${raw.slice(-8)}`;
}

function parseSessionEventFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
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
        rows.push(JSON.parse(trimmed));
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

function computeToolSignals(sessionId, eventRows) {
  const starts = [];
  const toolCounts = new Map();
  const perRequestToolCounts = new Map();
  const consecutiveRuns = [];

  let previousByRequest = new Map();
  for (const row of eventRows) {
    if (row.event_type !== 'tool_start') {
      continue;
    }
    const payload = row && typeof row.payload === 'object' ? row.payload : {};
    const toolName = String(payload.toolName || '(unknown tool)').trim() || '(unknown tool)';
    const requestId = String(row.request_id || '(unknown)').trim() || '(unknown)';
    const timestamp = Math.round(toNumber(row.timestamp));
    starts.push({ requestId, toolName, timestamp });
    toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);

    const requestKey = `${requestId}::${toolName}`;
    perRequestToolCounts.set(requestKey, (perRequestToolCounts.get(requestKey) || 0) + 1);

    const prev = previousByRequest.get(requestId);
    if (!prev || prev.toolName !== toolName) {
      if (prev && prev.runLength >= 4) {
        consecutiveRuns.push({
          requestId,
          toolName: prev.toolName,
          count: prev.runLength,
          startTs: prev.startTs,
          endTs: prev.endTs,
        });
      }
      previousByRequest.set(requestId, {
        toolName,
        runLength: 1,
        startTs: timestamp,
        endTs: timestamp,
      });
    } else {
      prev.runLength += 1;
      prev.endTs = timestamp;
      previousByRequest.set(requestId, prev);
    }
  }

  for (const [requestId, prev] of previousByRequest.entries()) {
    if (prev.runLength >= 4) {
      consecutiveRuns.push({
        requestId,
        toolName: prev.toolName,
        count: prev.runLength,
        startTs: prev.startTs,
        endTs: prev.endTs,
      });
    }
  }

  const highFrequencyLoops = [];
  for (const [requestTool, count] of perRequestToolCounts.entries()) {
    if (count > 5) {
      const pivot = requestTool.indexOf('::');
      const requestId = requestTool.slice(0, pivot);
      const toolName = requestTool.slice(pivot + 2);
      highFrequencyLoops.push({ requestId, toolName, count });
    }
  }

  highFrequencyLoops.sort((a, b) => b.count - a.count);
  consecutiveRuns.sort((a, b) => b.count - a.count);
  const toolSequence = starts
    .slice(0, MAX_TOOL_EVENTS_PER_SESSION)
    .map((item) => ({ ...item }));

  const sortedCounts = [...toolCounts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, MAX_TOOLS_PER_SESSION);

  return {
    sessionId,
    toolCounts: sortedCounts,
    toolSequence,
    loops: {
      highFrequency: highFrequencyLoops.slice(0, 8),
      consecutive: consecutiveRuns.slice(0, 8),
    },
  };
}

function buildSessionSummariesSql(baseQuery) {
  return `${baseQuery}
SELECT
  session_id,
  COALESCE(MAX(agent_id), '') AS agent_id,
  COALESCE(MAX(agent_version), '') AS agent_version,
  COALESCE(MAX(engine), '') AS engine,
  ROUND(COALESCE(SUM(cost), 0), 6) AS total_cost,
  COUNT(*) AS llm_calls,
  COUNT(DISTINCT COALESCE(request_id, trace_id)) AS requests,
  COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
  ROUND(COALESCE(AVG(duration_ms), 0), 0) AS avg_latency_ms,
  ROUND(COALESCE(SUM(duration_ms), 0), 0) AS total_latency_ms,
  MIN(start_ms) AS started_ms,
  MAX(start_ms) AS latest_ms
FROM extracted
WHERE session_id IS NOT NULL AND session_id != ''
GROUP BY session_id
ORDER BY latest_ms DESC
LIMIT ${SESSION_LIMIT};`;
}

function buildModelBreakdownSql(baseQuery) {
  return `${baseQuery}
SELECT
  session_id,
  COALESCE(model, 'unknown') AS model,
  ROUND(COALESCE(SUM(cost), 0), 6) AS total_cost,
  COUNT(*) AS calls,
  COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS tokens
FROM extracted
WHERE session_id IN (
  SELECT session_id FROM extracted
  WHERE session_id IS NOT NULL AND session_id != ''
  GROUP BY session_id ORDER BY MAX(start_ms) DESC LIMIT ${SESSION_LIMIT}
)
GROUP BY session_id, model
ORDER BY session_id, total_cost DESC;`;
}

function buildLlmSequenceSql(baseQuery) {
  return `${baseQuery}
, ranked AS (
  SELECT
    session_id,
    COALESCE(request_id, trace_id) AS request_id,
    start_ms,
    COALESCE(model, 'unknown') AS model,
    COALESCE(cost, 0) AS cost,
    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY start_ms ASC) AS rn
  FROM extracted
  WHERE session_id IN (
    SELECT session_id FROM extracted
    WHERE session_id IS NOT NULL AND session_id != ''
    GROUP BY session_id ORDER BY MAX(start_ms) DESC LIMIT ${SESSION_LIMIT}
  )
)
SELECT
  session_id,
  request_id,
  start_ms,
  model,
  cost
FROM ranked
WHERE rn <= ${MAX_LLM_EVENTS_PER_SESSION}
ORDER BY session_id, start_ms ASC;`;
}

function buildSessionPayload(
  sessionRows,
  modelRows,
  llmRows,
  sessionToolSignals,
  activeSessionId,
) {
  const bySessionModels = new Map();
  for (const row of modelRows) {
    const sessionId = String(row.session_id || '').trim();
    if (!sessionId) {
      continue;
    }
    if (!bySessionModels.has(sessionId)) {
      bySessionModels.set(sessionId, []);
    }
    bySessionModels.get(sessionId).push({
      model: String(row.model || 'unknown'),
      cost: toNumber(row.total_cost),
      calls: Math.max(0, Math.round(toNumber(row.calls))),
      tokens: Math.max(0, Math.round(toNumber(row.tokens))),
    });
  }

  const bySessionLlm = new Map();
  for (const row of llmRows) {
    const sessionId = String(row.session_id || '').trim();
    if (!sessionId) {
      continue;
    }
    if (!bySessionLlm.has(sessionId)) {
      bySessionLlm.set(sessionId, []);
    }
    bySessionLlm.get(sessionId).push({
      requestId: String(row.request_id || '(unknown)').trim() || '(unknown)',
      startMs: Math.round(toNumber(row.start_ms)),
      model: String(row.model || 'unknown'),
      cost: toNumber(row.cost),
    });
  }

  const toolSignalMap = new Map();
  for (const entry of sessionToolSignals) {
    toolSignalMap.set(entry.sessionId, entry);
  }

  const normalizedActive = String(activeSessionId || '').trim();
  return sessionRows.map((row, index) => {
    const sessionId = String(row.session_id || '').trim();
    const models = (bySessionModels.get(sessionId) || [])
      .sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model))
      .slice(0, MAX_MODELS_PER_SESSION);
    const llmSequence = (bySessionLlm.get(sessionId) || []).map((item) => ({ ...item }));
    const toolSignal = toolSignalMap.get(sessionId) || {
      toolCounts: [],
      toolSequence: [],
      loops: { highFrequency: [], consecutive: [] },
    };
    return {
      sessionId,
      handle: sessionHandle(sessionId),
      isActive: normalizedActive ? sessionId === normalizedActive : index === 0,
      agentId: String(row.agent_id || ''),
      agentVersion: String(row.agent_version || ''),
      engine: String(row.engine || ''),
      totalCost: toNumber(row.total_cost),
      llmCalls: Math.max(0, Math.round(toNumber(row.llm_calls))),
      requestCount: Math.max(0, Math.round(toNumber(row.requests))),
      totalTokens: Math.max(0, Math.round(toNumber(row.total_tokens))),
      avgLatencyMs: Math.max(0, Math.round(toNumber(row.avg_latency_ms))),
      totalLatencyMs: Math.max(0, Math.round(toNumber(row.total_latency_ms))),
      startedMs: Math.round(toNumber(row.started_ms)),
      latestMs: Math.round(toNumber(row.latest_ms)),
      modelBreakdown: models,
      llmSequence,
      toolCounts: toolSignal.toolCounts || [],
      toolSequence: toolSignal.toolSequence || [],
      loops: toolSignal.loops || { highFrequency: [], consecutive: [] },
    };
  });
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
  <title>Session Comparison</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111b2f;
      --panel-soft: #15243d;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --border: #21324d;
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
      background: #0d172b;
      padding: 12px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title {
      font-weight: 700;
      font-size: 14px;
    }
    .pill {
      border: 1px solid #25467d;
      color: #93c5fd;
      background: #132341;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
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
      max-height: 74vh;
      overflow: auto;
      display: grid;
      gap: 8px;
      padding-right: 2px;
    }
    .session-item {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel);
      padding: 9px;
      display: grid;
      gap: 6px;
    }
    .session-item-title {
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .live {
      border: 1px solid #14532d;
      color: #86efac;
      background: #052e16;
      border-radius: 999px;
      font-size: 10px;
      padding: 1px 6px;
      font-weight: 700;
    }
    .session-meta {
      color: var(--muted);
      font-size: 11px;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .assign {
      display: flex;
      gap: 6px;
    }
    .assign button {
      flex: 1;
      border: 1px solid #2f4f7d;
      background: #11213c;
      color: #cbd5e1;
      border-radius: 7px;
      font-size: 11px;
      padding: 4px 7px;
      cursor: pointer;
    }
    .assign button:hover { border-color: #3b82f6; color: #dbeafe; }
    .main {
      padding: 14px;
      display: grid;
      gap: 10px;
      min-width: 0;
      align-content: start;
    }
    .controls {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--panel);
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .selectors {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 10px;
      align-items: center;
    }
    .selectors label {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 11px;
    }
    select {
      width: 100%;
      background: #0a1324;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 7px 8px;
      font-size: 12px;
      outline: none;
    }
    select:focus { border-color: var(--accent); }
    .vs {
      text-align: center;
      font-size: 11px;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 5px 8px;
      background: #0f1b2f;
    }
    .quick-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .quick-actions button {
      border: 1px solid #2f4f7d;
      background: #11213c;
      color: #cbd5e1;
      border-radius: 7px;
      font-size: 11px;
      padding: 5px 9px;
      cursor: pointer;
    }
    .quick-actions button:hover { border-color: #3b82f6; color: #dbeafe; }
    .summary {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: #0f1a2f;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .summary-title {
      font-weight: 700;
      color: #bfdbfe;
    }
    .summary-list {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 4px;
      color: #cbd5e1;
      font-size: 12px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(130px, 1fr));
      gap: 8px;
    }
    .metric {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #0d1729;
      padding: 8px;
      display: grid;
      gap: 3px;
    }
    .metric-label { color: var(--muted); font-size: 11px; }
    .metric-value { font-size: 15px; font-weight: 700; }
    .metric-delta { font-size: 11px; }
    .delta-good { color: #86efac; }
    .delta-bad { color: #fca5a5; }
    .delta-neutral { color: #cbd5e1; }
    .panes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .pane {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel-soft);
      padding: 9px;
      display: grid;
      gap: 6px;
    }
    .pane h3 {
      margin: 0;
      font-size: 12px;
      color: #bfdbfe;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .small {
      color: var(--muted);
      font-size: 11px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      background: #0b1628;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      padding: 7px 8px;
      border-top: 1px solid rgba(148, 163, 184, 0.2);
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #101f37;
      color: #93c5fd;
      font-size: 11px;
      border-top: none;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .table-wrap {
      overflow: auto;
      max-height: 300px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .seq-wrap {
      display: grid;
      gap: 8px;
      grid-template-columns: 1fr 1fr;
    }
    .seq-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #0b1628;
      padding: 8px;
      display: grid;
      gap: 6px;
    }
    .seq-list {
      margin: 0;
      padding-left: 18px;
      color: #cbd5e1;
      max-height: 220px;
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.4;
    }
    .loop-badge {
      color: #fde68a;
      border: 1px solid #78350f;
      background: #422006;
      border-radius: 999px;
      font-size: 10px;
      padding: 1px 6px;
      margin-left: 6px;
      white-space: nowrap;
    }
    .empty {
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      background: #0c1525;
      padding: 12px;
      text-align: center;
    }
    @media (max-width: 1080px) {
      .root { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--border); }
      .selectors { grid-template-columns: 1fr; }
      .vs { justify-self: start; }
      .metrics { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .panes { grid-template-columns: 1fr; }
      .seq-wrap { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="root">
    <aside class="sidebar">
      <div class="title-row">
        <div class="title">Session Comparison</div>
        <div class="pill">Interactive HTML</div>
      </div>
      <input id="session-search" class="search" placeholder="Search session / agent / version" />
      <div id="session-list" class="session-list"></div>
    </aside>
    <main class="main">
      <section class="controls">
        <div class="selectors">
          <label>
            Session A
            <select id="session-a"></select>
          </label>
          <div class="vs">VS</div>
          <label>
            Session B
            <select id="session-b"></select>
          </label>
        </div>
        <div class="quick-actions">
          <button id="copy-a" type="button">Copy A session id</button>
          <button id="copy-b" type="button">Copy B session id</button>
          <button id="swap" type="button">Swap A/B</button>
        </div>
      </section>

      <section class="summary">
        <div class="summary-title">What changed</div>
        <ul id="summary-list" class="summary-list"></ul>
      </section>

      <section class="metrics" id="metrics"></section>

      <section class="panes" id="session-panes"></section>

      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>A</th>
              <th>B</th>
              <th>Delta (B-A)</th>
            </tr>
          </thead>
          <tbody id="tool-diff-body"></tbody>
        </table>
      </section>

      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>A Cost</th>
              <th>B Cost</th>
              <th>Calls A/B</th>
              <th>Delta (B-A)</th>
            </tr>
          </thead>
          <tbody id="model-diff-body"></tbody>
        </table>
      </section>

      <section class="seq-wrap">
        <div class="seq-card">
          <div class="summary-title">Tool call order (first ${MAX_SEQUENCE_RENDER})</div>
          <ol id="tool-seq-a" class="seq-list"></ol>
        </div>
        <div class="seq-card">
          <div class="summary-title">Tool call order (first ${MAX_SEQUENCE_RENDER})</div>
          <ol id="tool-seq-b" class="seq-list"></ol>
        </div>
      </section>

      <section class="seq-wrap">
        <div class="seq-card">
          <div class="summary-title">LLM model order (first ${MAX_SEQUENCE_RENDER})</div>
          <ol id="llm-seq-a" class="seq-list"></ol>
        </div>
        <div class="seq-card">
          <div class="summary-title">LLM model order (first ${MAX_SEQUENCE_RENDER})</div>
          <ol id="llm-seq-b" class="seq-list"></ol>
        </div>
      </section>
    </main>
  </div>
  <script>
    const data = ${safeJson};
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));

    const state = {
      search: '',
      selectedA: (() => {
        const active = sessions.find((session) => session.isActive);
        return active ? active.sessionId : (sessions[0] ? sessions[0].sessionId : '');
      })(),
      selectedB: (() => {
        const active = sessions.find((session) => session.isActive);
        const fallback = sessions.find((session) => !active || session.sessionId !== active.sessionId);
        return fallback ? fallback.sessionId : (sessions[0] ? sessions[0].sessionId : '');
      })(),
    };

    const esc = (v) => String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    const num = (v) => Number(v || 0);
    const fmtNum = (v) => num(v).toLocaleString();
    const fmtMoney = (v) => '$' + num(v).toFixed(4);
    const fmtMs = (v) => {
      const value = num(v);
      if (!value) return '-';
      if (value < 1000) return Math.round(value) + 'ms';
      return (value / 1000).toFixed(2) + 's';
    };
    const fmtAgo = (ms) => {
      const value = num(ms);
      if (!value) return '-';
      const deltaSec = Math.floor((Date.now() - value) / 1000);
      if (deltaSec < 60) return 'just now';
      if (deltaSec < 3600) return Math.floor(deltaSec / 60) + 'm ago';
      if (deltaSec < 86400) return Math.floor(deltaSec / 3600) + 'h ago';
      return Math.floor(deltaSec / 86400) + 'd ago';
    };

    const el = {
      search: document.getElementById('session-search'),
      list: document.getElementById('session-list'),
      a: document.getElementById('session-a'),
      b: document.getElementById('session-b'),
      copyA: document.getElementById('copy-a'),
      copyB: document.getElementById('copy-b'),
      swap: document.getElementById('swap'),
      summaryList: document.getElementById('summary-list'),
      metrics: document.getElementById('metrics'),
      panes: document.getElementById('session-panes'),
      toolDiffBody: document.getElementById('tool-diff-body'),
      modelDiffBody: document.getElementById('model-diff-body'),
      toolSeqA: document.getElementById('tool-seq-a'),
      toolSeqB: document.getElementById('tool-seq-b'),
      llmSeqA: document.getElementById('llm-seq-a'),
      llmSeqB: document.getElementById('llm-seq-b'),
    };

    function postCopy(sessionId) {
      if (!sessionId) return;
      window.parent.postMessage({
        source: 'agentide-wow-widget',
        type: 'copySessionId',
        sessionId,
      }, '*');
    }

    function getFilteredSessions() {
      const query = state.search.trim().toLowerCase();
      if (!query) return sessions;
      return sessions.filter((session) => {
        const sid = String(session.sessionId || '').toLowerCase();
        const agent = String(session.agentId || '').toLowerCase();
        const engine = String(session.engine || '').toLowerCase();
        const version = String(session.agentVersion || '').toLowerCase();
        return sid.includes(query) || agent.includes(query) || engine.includes(query) || version.includes(query);
      });
    }

    function renderSessionList() {
      const filtered = getFilteredSessions();
      if (!filtered.length) {
        el.list.innerHTML = '<div class="empty">No matching sessions.</div>';
        return;
      }
      el.list.innerHTML = filtered.map((session) => {
        const live = session.isActive ? '<span class="live">LIVE</span>' : '';
        return '<div class="session-item">' +
          '<div class="session-item-title"><span title="' + esc(session.sessionId) + '">' + esc(session.handle || session.sessionId) + '</span>' + live + '</div>' +
          '<div class="session-meta">' +
            '<span>' + fmtMoney(session.totalCost) + '</span>' +
            '<span>' + fmtNum(session.llmCalls) + ' LLM</span>' +
            '<span>' + fmtNum(session.requestCount) + ' req</span>' +
            '<span>' + esc(fmtAgo(session.latestMs)) + '</span>' +
          '</div>' +
          '<div class="session-meta">' +
            '<span>agent ' + esc(session.agentId || '(n/a)') + '</span>' +
            '<span>engine ' + esc(session.engine || '(n/a)') + '</span>' +
            '<span>version ' + esc(session.agentVersion || '(n/a)') + '</span>' +
          '</div>' +
          '<div class="assign">' +
            '<button type="button" data-slot="a" data-session-id="' + esc(session.sessionId) + '">Set A</button>' +
            '<button type="button" data-slot="b" data-session-id="' + esc(session.sessionId) + '">Set B</button>' +
          '</div>' +
        '</div>';
      }).join('');

      el.list.querySelectorAll('button[data-slot]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const slot = btn.getAttribute('data-slot');
          const sessionId = btn.getAttribute('data-session-id');
          if (!sessionId) return;
          if (slot === 'a') {
            state.selectedA = sessionId;
            if (state.selectedA === state.selectedB) {
              const other = sessions.find((session) => session.sessionId !== state.selectedA);
              if (other) state.selectedB = other.sessionId;
            }
          } else {
            state.selectedB = sessionId;
            if (state.selectedA === state.selectedB) {
              const other = sessions.find((session) => session.sessionId !== state.selectedB);
              if (other) state.selectedA = other.sessionId;
            }
          }
          render();
        });
      });
    }

    function renderSelectors() {
      const options = sessions.map((session) =>
        '<option value="' + esc(session.sessionId) + '">' + esc((session.handle || session.sessionId) + ' · ' + (session.engine || 'engine:n/a') + ' · ' + fmtMoney(session.totalCost)) + '</option>'
      ).join('');
      el.a.innerHTML = options;
      el.b.innerHTML = options;
      if (!byId.has(state.selectedA) && sessions[0]) {
        state.selectedA = sessions[0].sessionId;
      }
      if (!byId.has(state.selectedB) && sessions[1]) {
        state.selectedB = sessions[1].sessionId;
      }
      if (state.selectedA === state.selectedB) {
        const other = sessions.find((session) => session.sessionId !== state.selectedA);
        if (other) {
          state.selectedB = other.sessionId;
        }
      }
      el.a.value = state.selectedA || '';
      el.b.value = state.selectedB || '';
    }

    function deltaClass(delta, betterWhenLower = true) {
      if (delta === 0) return 'delta-neutral';
      const improved = betterWhenLower ? delta < 0 : delta > 0;
      return improved ? 'delta-good' : 'delta-bad';
    }

    function ratioText(a, b) {
      const left = Math.max(0.000001, num(a));
      const right = Math.max(0.000001, num(b));
      return (right / left).toFixed(2) + 'x';
    }

    function buildWhatChanged(a, b, toolRows, modelRows) {
      const lines = [];
      const costDelta = num(b.totalCost) - num(a.totalCost);
      if (Math.abs(costDelta) > 0.0005) {
        if (costDelta > 0) {
          lines.push('Session B cost ' + ratioText(a.totalCost, b.totalCost) + ' more (' + fmtMoney(b.totalCost) + ' vs ' + fmtMoney(a.totalCost) + ').');
        } else {
          lines.push('Session B cost less (' + fmtMoney(b.totalCost) + ' vs ' + fmtMoney(a.totalCost) + ').');
        }
      }
      const latencyDelta = num(b.totalLatencyMs) - num(a.totalLatencyMs);
      if (Math.abs(latencyDelta) > 100) {
        lines.push('Total latency changed by ' + fmtMs(Math.abs(latencyDelta)) + (latencyDelta > 0 ? ' higher in B.' : ' lower in B.'));
      }
      const tokenDelta = num(b.totalTokens) - num(a.totalTokens);
      if (Math.abs(tokenDelta) > 200) {
        lines.push('Token usage delta: ' + (tokenDelta > 0 ? '+' : '') + fmtNum(tokenDelta) + ' (B-A).');
      }
      const topToolShift = toolRows[0];
      if (topToolShift && Math.abs(topToolShift.delta) >= 3) {
        lines.push('Biggest tool shift: ' + topToolShift.tool + ' changed by ' + (topToolShift.delta > 0 ? '+' : '') + topToolShift.delta + ' calls.');
      }
      const loopB = Array.isArray(b.loops?.highFrequency) ? b.loops.highFrequency[0] : null;
      if (loopB) {
        lines.push('Loop risk in B: ' + loopB.toolName + ' called ' + loopB.count + ' times in request ' + loopB.requestId + '.');
      }
      const loopA = Array.isArray(a.loops?.highFrequency) ? a.loops.highFrequency[0] : null;
      if (loopA) {
        lines.push('Loop seen in A too: ' + loopA.toolName + ' x' + loopA.count + '.');
      }
      const newModelInB = modelRows.find((row) => row.callsA === 0 && row.callsB > 0);
      if (newModelInB) {
        lines.push('Session B used new model ' + newModelInB.model + ' (' + fmtMoney(newModelInB.costB) + ').');
      }
      if (!lines.length) {
        lines.push('No major regressions or shifts detected between these two sessions.');
      }
      return lines.slice(0, 7);
    }

    function buildToolDiff(a, b) {
      const mapA = new Map((a.toolCounts || []).map((item) => [item.tool, item.count]));
      const mapB = new Map((b.toolCounts || []).map((item) => [item.tool, item.count]));
      const keys = new Set([...mapA.keys(), ...mapB.keys()]);
      const loopsA = new Set((a.loops?.highFrequency || []).map((loop) => loop.toolName));
      const loopsB = new Set((b.loops?.highFrequency || []).map((loop) => loop.toolName));
      return [...keys].map((tool) => {
        const countA = num(mapA.get(tool));
        const countB = num(mapB.get(tool));
        return {
          tool,
          countA,
          countB,
          delta: countB - countA,
          loopA: loopsA.has(tool),
          loopB: loopsB.has(tool),
        };
      }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || y.countB - x.countB || x.tool.localeCompare(y.tool));
    }

    function buildModelDiff(a, b) {
      const mapA = new Map((a.modelBreakdown || []).map((item) => [item.model, item]));
      const mapB = new Map((b.modelBreakdown || []).map((item) => [item.model, item]));
      const keys = new Set([...mapA.keys(), ...mapB.keys()]);
      return [...keys].map((model) => {
        const left = mapA.get(model) || { cost: 0, calls: 0 };
        const right = mapB.get(model) || { cost: 0, calls: 0 };
        return {
          model,
          costA: num(left.cost),
          costB: num(right.cost),
          callsA: num(left.calls),
          callsB: num(right.calls),
          delta: num(right.cost) - num(left.cost),
        };
      }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || y.costB - x.costB || x.model.localeCompare(y.model));
    }

    function renderMetrics(a, b) {
      const metrics = [
        { label: 'Cost', a: a.totalCost, b: b.totalCost, format: fmtMoney, lowerIsBetter: true },
        { label: 'Total latency', a: a.totalLatencyMs, b: b.totalLatencyMs, format: fmtMs, lowerIsBetter: true },
        { label: 'Tokens', a: a.totalTokens, b: b.totalTokens, format: fmtNum, lowerIsBetter: true },
        { label: 'LLM calls', a: a.llmCalls, b: b.llmCalls, format: fmtNum, lowerIsBetter: true },
      ];
      el.metrics.innerHTML = metrics.map((metric) => {
        const delta = num(metric.b) - num(metric.a);
        const sign = delta > 0 ? '+' : '';
        const cls = deltaClass(delta, metric.lowerIsBetter);
        return '<div class="metric">' +
          '<div class="metric-label">' + esc(metric.label) + '</div>' +
          '<div class="metric-value">' + esc(metric.format(metric.a)) + ' → ' + esc(metric.format(metric.b)) + '</div>' +
          '<div class="metric-delta ' + cls + '">' + esc(sign + (metric.label === 'Cost' ? fmtMoney(delta) : metric.format(delta)) + ' (B-A)') + '</div>' +
        '</div>';
      }).join('');
    }

    function renderPanes(a, b) {
      const renderPane = (session, label) => {
        return '<div class="pane">' +
          '<h3>' + esc(label) + '<span class="small">' + esc(session.handle) + '</span></h3>' +
          '<div class="small">session: ' + esc(session.sessionId) + '</div>' +
          '<div class="small">agent: ' + esc(session.agentId || '(n/a)') + ' · engine: ' + esc(session.engine || '(n/a)') + ' · version: ' + esc(session.agentVersion || '(n/a)') + '</div>' +
          '<div class="small">started: ' + esc(new Date(session.startedMs).toLocaleString()) + ' · latest: ' + esc(fmtAgo(session.latestMs)) + '</div>' +
          '<div class="small">cost ' + fmtMoney(session.totalCost) + ' · requests ' + fmtNum(session.requestCount) + ' · avg latency ' + fmtMs(session.avgLatencyMs) + '</div>' +
          '<div class="small">loops: ' + fmtNum((session.loops?.highFrequency || []).length) + ' high-frequency, ' + fmtNum((session.loops?.consecutive || []).length) + ' consecutive-run</div>' +
        '</div>';
      };
      el.panes.innerHTML = renderPane(a, 'Session A') + renderPane(b, 'Session B');
    }

    function renderToolDiff(toolRows) {
      if (!toolRows.length) {
        el.toolDiffBody.innerHTML = '<tr><td colspan="4"><div class="empty">No tool data available.</div></td></tr>';
        return;
      }
      el.toolDiffBody.innerHTML = toolRows.map((row) => {
        const cls = deltaClass(row.delta, true);
        const loopBadgeA = row.loopA ? '<span class="loop-badge">LOOP A</span>' : '';
        const loopBadgeB = row.loopB ? '<span class="loop-badge">LOOP B</span>' : '';
        return '<tr>' +
          '<td>' + esc(row.tool) + loopBadgeA + loopBadgeB + '</td>' +
          '<td>' + esc(fmtNum(row.countA)) + '</td>' +
          '<td>' + esc(fmtNum(row.countB)) + '</td>' +
          '<td class="' + cls + '">' + esc((row.delta > 0 ? '+' : '') + fmtNum(row.delta)) + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderModelDiff(modelRows) {
      if (!modelRows.length) {
        el.modelDiffBody.innerHTML = '<tr><td colspan="5"><div class="empty">No model data available.</div></td></tr>';
        return;
      }
      el.modelDiffBody.innerHTML = modelRows.map((row) => {
        const cls = deltaClass(row.delta, true);
        return '<tr>' +
          '<td>' + esc(row.model) + '</td>' +
          '<td>' + esc(fmtMoney(row.costA)) + '</td>' +
          '<td>' + esc(fmtMoney(row.costB)) + '</td>' +
          '<td>' + esc(fmtNum(row.callsA) + ' / ' + fmtNum(row.callsB)) + '</td>' +
          '<td class="' + cls + '">' + esc((row.delta > 0 ? '+' : '') + fmtMoney(row.delta)) + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderSequence(listEl, sequence, formatter) {
      if (!sequence.length) {
        listEl.innerHTML = '<li>(no events)</li>';
        return;
      }
      listEl.innerHTML = sequence
        .slice(0, ${MAX_SEQUENCE_RENDER})
        .map((item, index) => '<li>' + esc((index + 1) + '. ' + formatter(item)) + '</li>')
        .join('');
    }

    function renderComparison() {
      const a = byId.get(state.selectedA);
      const b = byId.get(state.selectedB);
      if (!a || !b) {
        el.summaryList.innerHTML = '<li>Select two sessions to compare.</li>';
        el.metrics.innerHTML = '';
        el.panes.innerHTML = '';
        el.toolDiffBody.innerHTML = '<tr><td colspan="4"><div class="empty">Select sessions.</div></td></tr>';
        el.modelDiffBody.innerHTML = '<tr><td colspan="5"><div class="empty">Select sessions.</div></td></tr>';
        return;
      }

      const toolRows = buildToolDiff(a, b);
      const modelRows = buildModelDiff(a, b);
      const summaryLines = buildWhatChanged(a, b, toolRows, modelRows);
      el.summaryList.innerHTML = summaryLines.map((line) => '<li>' + esc(line) + '</li>').join('');
      renderMetrics(a, b);
      renderPanes(a, b);
      renderToolDiff(toolRows);
      renderModelDiff(modelRows);

      renderSequence(el.toolSeqA, a.toolSequence || [], (item) => (item.requestId || '(req)') + ' · ' + (item.toolName || '(tool)'));
      renderSequence(el.toolSeqB, b.toolSequence || [], (item) => (item.requestId || '(req)') + ' · ' + (item.toolName || '(tool)'));
      renderSequence(el.llmSeqA, a.llmSequence || [], (item) => (item.requestId || '(req)') + ' · ' + (item.model || 'unknown'));
      renderSequence(el.llmSeqB, b.llmSequence || [], (item) => (item.requestId || '(req)') + ' · ' + (item.model || 'unknown'));
    }

    function render() {
      renderSelectors();
      renderSessionList();
      renderComparison();
    }

    el.search.addEventListener('input', () => {
      state.search = el.search.value || '';
      renderSessionList();
    });
    el.a.addEventListener('change', () => {
      state.selectedA = el.a.value;
      if (state.selectedA === state.selectedB) {
        const other = sessions.find((session) => session.sessionId !== state.selectedA);
        if (other) {
          state.selectedB = other.sessionId;
        }
      }
      render();
    });
    el.b.addEventListener('change', () => {
      state.selectedB = el.b.value;
      if (state.selectedA === state.selectedB) {
        const other = sessions.find((session) => session.sessionId !== state.selectedB);
        if (other) {
          state.selectedA = other.sessionId;
        }
      }
      render();
    });
    el.copyA.addEventListener('click', () => {
      postCopy(state.selectedA);
      el.copyA.textContent = 'Copied A';
      setTimeout(() => { el.copyA.textContent = 'Copy A session id'; }, 1100);
    });
    el.copyB.addEventListener('click', () => {
      postCopy(state.selectedB);
      el.copyB.textContent = 'Copied B';
      setTimeout(() => { el.copyB.textContent = 'Copy B session id'; }, 1100);
    });
    el.swap.addEventListener('click', () => {
      const temp = state.selectedA;
      state.selectedA = state.selectedB;
      state.selectedB = temp;
      render();
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
  const outputPath = path.join(chartDir, 'session-comparison-widget.html');
  const activeSessionId = String(process.env.AGENTIDE_ACTIVE_SESSION_ID || '').trim();

  fs.mkdirSync(chartDir, { recursive: true });
  if (isOutputDisabled('session-comparison-widget.html')) {
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
    { name: 'sessions', sql: buildSessionSummariesSql(baseQuery) },
    { name: 'models', sql: buildModelBreakdownSql(baseQuery) },
    { name: 'llm', sql: buildLlmSequenceSql(baseQuery) },
  ], dbPath);

  // Run against indexed DB first when available; fall back to JSONL if indexed query fails.
  let batch = runQueries(buildBaseQuery(tracesDir, Boolean(indexedDbPath)), indexedDbPath);
  if (indexedDbPath && batch.failed) {
    console.error('session-comparison-widget indexed query failed; falling back to JSONL parsing');
    batch = runQueries(buildBaseQuery(tracesDir, false));
  }

  const batchResults = batch.result;
  const sessionRows = batchResults.sessions;
  if (!sessionRows.length) {
    fs.writeFileSync(outputPath, buildFallbackHtml('No sessions found for comparison.'), 'utf8');
    return;
  }

  const modelRows = batchResults.models;
  const llmRows = batchResults.llm;
  const sessionIds = sessionRows
    .map((row) => String(row.session_id || '').trim())
    .filter(Boolean);
  const sessionToolSignals = sessionIds.map((sessionId) => {
    const eventRows = parseSessionEventFile(path.join(sessionsDir, `${sessionId}.jsonl`));
    return computeToolSignals(sessionId, eventRows);
  });

  const sessions = buildSessionPayload(
    sessionRows,
    modelRows,
    llmRows,
    sessionToolSignals,
    activeSessionId,
  );
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    activeSessionId: activeSessionId || null,
    limits: {
      sessionLimit: SESSION_LIMIT,
      maxLlmEventsPerSession: MAX_LLM_EVENTS_PER_SESSION,
      maxToolEventsPerSession: MAX_TOOL_EVENTS_PER_SESSION,
      maxSequenceRender: MAX_SEQUENCE_RENDER,
    },
    sessions,
  };
  fs.writeFileSync(outputPath, buildHtml(payload), 'utf8');
}

main();
