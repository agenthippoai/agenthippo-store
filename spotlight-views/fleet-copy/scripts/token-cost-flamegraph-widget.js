#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const MAX_TRACE_FILES = 30;
const MAX_SPANS_TOTAL = 14_000;
const MAX_PATH_DEPTH = 10;
const MAX_CHILDREN_PER_NODE = 80;
const COST_UNITS_PER_DOLLAR = 100_000;

const TOKEN_KEYS_IN = [
  'gen_ai.usage.input_tokens',
  'llm.usage.prompt_tokens',
  'llm.token_count.prompt',
];
const TOKEN_KEYS_OUT = [
  'gen_ai.usage.output_tokens',
  'llm.usage.completion_tokens',
  'llm.token_count.completion',
];
const COST_KEYS = [
  'gen_ai.cost.total_cost',
  'llm.cost.total_cost',
  'cost',
];
const MODEL_KEYS = [
  'gen_ai.request.model',
  'gen_ai.response.model',
  'model',
];
const TOOL_KEYS = [
  'tool.name',
  'gen_ai.tool.name',
];

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

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function listTraceFiles(tracesDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(tracesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(tracesDir, entry.name))
    .map((filePath) => ({
      filePath,
      mtime: fs.statSync(filePath).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_TRACE_FILES)
    .map((row) => row.filePath);
}

function parseAttributeValue(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (typeof value.stringValue === 'string') {
    return value.stringValue;
  }
  if (value.intValue !== undefined) {
    return toNumber(value.intValue);
  }
  if (value.doubleValue !== undefined) {
    return toNumber(value.doubleValue);
  }
  if (typeof value.boolValue === 'boolean') {
    return value.boolValue ? 1 : 0;
  }
  return null;
}

function attrsToMap(attributes) {
  const out = Object.create(null);
  if (!Array.isArray(attributes)) {
    return out;
  }
  for (const item of attributes) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const key = String(item.key || '').trim();
    if (!key) {
      continue;
    }
    out[key] = parseAttributeValue(item.value);
  }
  return out;
}

function firstNumber(attrs, keys) {
  for (const key of keys) {
    const raw = attrs[key];
    const value = toNumber(raw);
    if (value > 0) {
      return value;
    }
  }
  return 0;
}

function firstString(attrs, keys) {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function shortLabel(name, suffix) {
  const full = suffix ? `${name} (${suffix})` : name;
  if (full.length <= 78) {
    return full;
  }
  return `${full.slice(0, 75)}...`;
}

function extractSpansFromRecord(record, spans, traceSummaryMap) {
  if (!record || typeof record !== 'object') {
    return;
  }
  const resourceSpans = Array.isArray(record.resourceSpans) ? record.resourceSpans : [];
  for (const resourceSpan of resourceSpans) {
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : [];
    for (const scopeSpan of scopeSpans) {
      const scopeItems = Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : [];
      for (const span of scopeItems) {
        if (!span || typeof span !== 'object') {
          continue;
        }
        const traceId = String(span.traceId || '').trim();
        const spanId = String(span.spanId || '').trim();
        if (!traceId || !spanId) {
          continue;
        }
        const parentSpanId = String(span.parentSpanId || '').trim();
        const attrs = attrsToMap(span.attributes);
        const inputTokens = firstNumber(attrs, TOKEN_KEYS_IN);
        const outputTokens = firstNumber(attrs, TOKEN_KEYS_OUT);
        const totalTokens = Math.max(0, inputTokens + outputTokens);
        const cost = firstNumber(attrs, COST_KEYS);
        const costUnits = Math.max(0, Math.round(cost * COST_UNITS_PER_DOLLAR));
        const startNs = toNumber(span.startTimeUnixNano);
        const endNs = toNumber(span.endTimeUnixNano);
        const durationMs = endNs > startNs ? (endNs - startNs) / 1_000_000 : 0;
        const fallbackUnits = Math.max(1, Math.round(durationMs / 8));
        const hybridUnits = totalTokens + costUnits > 0 ? (totalTokens + costUnits) : fallbackUnits;
        const model = firstString(attrs, MODEL_KEYS);
        const tool = firstString(attrs, TOOL_KEYS);
        const spanName = String(span.name || '(unnamed span)').trim() || '(unnamed span)';
        const label = shortLabel(spanName, model || tool || '');

        spans.push({
          traceId,
          spanId,
          parentSpanId,
          label,
          startNs,
          durationMs,
          tokens: totalTokens,
          cost,
          costUnits,
          hybridUnits,
        });

        let summary = traceSummaryMap.get(traceId);
        if (!summary) {
          summary = {
            traceId,
            spans: 0,
            tokens: 0,
            cost: 0,
            hybridUnits: 0,
          };
          traceSummaryMap.set(traceId, summary);
        }
        summary.spans += 1;
        summary.tokens += totalTokens;
        summary.cost += cost;
        summary.hybridUnits += hybridUnits;
      }
    }
  }
}

function loadSpans(tracesDir) {
  const files = listTraceFiles(tracesDir);
  /** @type {Array<object>} */
  const spans = [];
  /** @type {Map<string, { traceId: string, spans: number, tokens: number, cost: number, hybridUnits: number }>} */
  const traceSummaryMap = new Map();

  for (const filePath of files) {
    if (spans.length >= MAX_SPANS_TOTAL) {
      break;
    }
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (spans.length >= MAX_SPANS_TOTAL) {
        break;
      }
      const trimmed = String(line || '').trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        extractSpansFromRecord(parsed, spans, traceSummaryMap);
      } catch {
        // Ignore malformed trace lines.
      }
    }
  }

  return {
    spans,
    filesUsed: files.length,
    traceCount: traceSummaryMap.size,
    traceSummaries: [...traceSummaryMap.values()]
      .sort((a, b) => b.hybridUnits - a.hybridUnits)
      .slice(0, 14),
  };
}

function createAggNode(name) {
  return {
    name,
    tokensOwn: 0,
    costOwn: 0,
    costUnitsOwn: 0,
    hybridOwn: 0,
    durationOwn: 0,
    callsOwn: 0,
    totalTokens: 0,
    totalCost: 0,
    totalCostUnits: 0,
    totalHybrid: 0,
    totalDuration: 0,
    totalCalls: 0,
    children: new Map(),
  };
}

function addPath(root, pathLabels, span) {
  let cursor = root;
  for (const label of pathLabels) {
    let next = cursor.children.get(label);
    if (!next) {
      next = createAggNode(label);
      cursor.children.set(label, next);
    }
    cursor = next;
  }
  cursor.tokensOwn += span.tokens;
  cursor.costOwn += span.cost;
  cursor.costUnitsOwn += span.costUnits;
  cursor.hybridOwn += span.hybridUnits;
  cursor.durationOwn += span.durationMs;
  cursor.callsOwn += 1;
}

function finalizeAgg(node) {
  let totalTokens = node.tokensOwn;
  let totalCost = node.costOwn;
  let totalCostUnits = node.costUnitsOwn;
  let totalHybrid = node.hybridOwn;
  let totalDuration = node.durationOwn;
  let totalCalls = node.callsOwn;
  for (const child of node.children.values()) {
    finalizeAgg(child);
    totalTokens += child.totalTokens;
    totalCost += child.totalCost;
    totalCostUnits += child.totalCostUnits;
    totalHybrid += child.totalHybrid;
    totalDuration += child.totalDuration;
    totalCalls += child.totalCalls;
  }
  node.totalTokens = totalTokens;
  node.totalCost = totalCost;
  node.totalCostUnits = totalCostUnits;
  node.totalHybrid = totalHybrid;
  node.totalDuration = totalDuration;
  node.totalCalls = totalCalls;
}

function buildAggregatedTree(spans) {
  /** @type {Map<string, Array<object>>} */
  const byTrace = new Map();
  for (const span of spans) {
    const traceId = String(span.traceId || '');
    if (!traceId) {
      continue;
    }
    let rows = byTrace.get(traceId);
    if (!rows) {
      rows = [];
      byTrace.set(traceId, rows);
    }
    rows.push(span);
  }

  const root = createAggNode('All traces');
  for (const traceSpans of byTrace.values()) {
    traceSpans.sort((a, b) => a.startNs - b.startNs);
    const bySpanId = new Map();
    for (const span of traceSpans) {
      bySpanId.set(span.spanId, { ...span, children: [] });
    }
    const roots = [];
    for (const span of bySpanId.values()) {
      if (span.parentSpanId && bySpanId.has(span.parentSpanId)) {
        bySpanId.get(span.parentSpanId).children.push(span);
      } else {
        roots.push(span);
      }
    }

    const stack = roots.map((node) => ({ node, path: [] }));
    while (stack.length > 0) {
      const current = stack.pop();
      const node = current.node;
      const pathLabels = [...current.path, node.label].slice(0, MAX_PATH_DEPTH);
      addPath(root, pathLabels, node);
      if (Array.isArray(node.children) && node.children.length > 0) {
        for (const child of node.children) {
          stack.push({ node: child, path: pathLabels });
        }
      }
    }
  }

  finalizeAgg(root);
  return root;
}

function serializeTree(root) {
  let idCounter = 0;
  function walk(node, parentPath) {
    const id = `n${idCounter++}`;
    const currentPath = node.name === 'All traces' ? parentPath : [...parentPath, node.name];
    const children = [...node.children.values()]
      .filter((child) => child.totalHybrid > 0)
      .sort((a, b) => b.totalHybrid - a.totalHybrid)
      .slice(0, MAX_CHILDREN_PER_NODE)
      .map((child) => walk(child, currentPath));
    return {
      id,
      name: node.name,
      path: currentPath.join(' > '),
      calls: node.totalCalls,
      durationMs: node.totalDuration,
      tokens: node.totalTokens,
      cost: node.totalCost,
      costUnits: node.totalCostUnits,
      hybrid: node.totalHybrid,
      children,
    };
  }
  return walk(root, []);
}

function buildFallbackHtml(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Token/Cost Flame Graph</title></head><body style="font-family:ui-sans-serif,system-ui;background:#0f111a;color:#e5e7eb;margin:0;padding:20px;"><h2 style="margin:0 0 8px;">Token/Cost Flame Graph</h2><p style="opacity:.85;">${message}</p></body></html>`;
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
  <title>Token/Cost Flame Graph</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #101a2f;
      --soft: #15233b;
      --border: #243757;
      --text: #e2e8f0;
      --muted: #9ab0cf;
      --accent: #38bdf8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .root {
      display: grid;
      grid-template-columns: minmax(620px, 1fr) minmax(280px, 360px);
      gap: 10px;
      padding: 12px;
      min-height: 96vh;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .head {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .title { font-weight: 700; font-size: 14px; }
    .meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
    .pill {
      border: 1px solid #2d5f8f;
      color: #bfdbfe;
      background: #112845;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      white-space: nowrap;
    }
    .toolbar {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    button {
      border: 1px solid #315685;
      background: #122642;
      color: #dbeafe;
      border-radius: 7px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    button:hover { border-color: #60a5fa; }
    button.active {
      background: #1d3d67;
      border-color: #60a5fa;
      color: #eff6ff;
    }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .plot-wrap {
      padding: 8px;
      height: min(76vh, 860px);
      overflow: auto;
      background: #091224;
    }
    svg {
      width: 100%;
      min-height: 340px;
      display: block;
      border-radius: 10px;
      border: 1px solid #1f3151;
      background: #070f1e;
    }
    .status {
      padding: 8px 12px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
      min-height: 33px;
    }
    .side {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      min-height: 0;
    }
    .block {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .block:last-child { border-bottom: none; }
    .name {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #dbeafe;
      word-break: break-word;
      font-size: 12px;
    }
    .path {
      color: var(--muted);
      font-size: 11px;
      margin-top: 6px;
      word-break: break-word;
    }
    .stats {
      margin-top: 8px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .stat {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px;
      background: var(--soft);
    }
    .stat .k {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .stat .v {
      margin-top: 2px;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .trace-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 7px;
      max-height: 28vh;
      overflow: auto;
    }
    .trace-list li {
      border: 1px solid #263a59;
      border-radius: 8px;
      background: #11203a;
      padding: 7px;
      font-size: 11px;
      color: #dbeafe;
      line-height: 1.35;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    @media (max-width: 1080px) {
      .root { grid-template-columns: 1fr; }
      .plot-wrap { height: min(58vh, 620px); }
      .trace-list { max-height: 20vh; }
    }
  </style>
</head>
<body>
  <div class="root">
    <section class="card">
      <div class="head">
        <div>
          <div class="title">Token/Cost Flame Graph</div>
          <div class="meta" id="chart-meta"></div>
        </div>
        <span class="pill">Interactive SVG</span>
      </div>
      <div class="toolbar">
        <button id="mode-hybrid" class="active" type="button">Hybrid (tokens + cost)</button>
        <button id="mode-tokens" type="button">Tokens</button>
        <button id="mode-cost" type="button">Cost</button>
        <button id="reset-zoom" type="button">Reset Zoom</button>
      </div>
      <div class="plot-wrap">
        <svg id="flame-svg" role="img" aria-label="Token cost flame graph"></svg>
      </div>
      <div class="status" id="status-line"></div>
    </section>

    <aside class="card side">
      <div class="block">
        <div class="title">Selected Frame</div>
        <div class="name" id="selected-name">Click a frame to inspect details.</div>
        <div class="path" id="selected-path"></div>
        <div class="stats" id="selected-stats"></div>
      </div>
      <div class="block">
        <button id="ask-ai-btn" type="button" disabled>Ask AI about this frame</button>
      </div>
      <div class="block">
        <div class="title">Top Traces in View</div>
        <ul id="trace-list" class="trace-list"></ul>
      </div>
      <div class="block">
        <div class="meta">Click a bar to zoom. Click again to step one level deeper.</div>
      </div>
    </aside>
  </div>

  <script>
    const payload = ${safeJson};
    const tree = payload.tree;
    const chartMetaEl = document.getElementById('chart-meta');
    const svg = document.getElementById('flame-svg');
    const statusLineEl = document.getElementById('status-line');
    const selectedNameEl = document.getElementById('selected-name');
    const selectedPathEl = document.getElementById('selected-path');
    const selectedStatsEl = document.getElementById('selected-stats');
    const traceListEl = document.getElementById('trace-list');
    const askAiBtn = document.getElementById('ask-ai-btn');
    const modeButtons = {
      hybrid: document.getElementById('mode-hybrid'),
      tokens: document.getElementById('mode-tokens'),
      cost: document.getElementById('mode-cost'),
    };
    const resetZoomBtn = document.getElementById('reset-zoom');

    const esc = (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    const num = (value) => Number(value || 0);
    const fmtNum = (value) => num(value).toLocaleString();
    const fmtMoney = (value) => '$' + num(value).toFixed(5);
    const fmtMs = (value) => {
      const n = num(value);
      if (!n) return '-';
      if (n < 1000) return Math.round(n) + 'ms';
      return (n / 1000).toFixed(2) + 's';
    };

    const index = new Map();
    const parentById = new Map();
    (function indexTree(node, parentId) {
      if (!node || typeof node !== 'object') return;
      index.set(node.id, node);
      if (parentId) parentById.set(node.id, parentId);
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) indexTree(child, node.id);
    })(tree, '');

    const state = {
      mode: 'hybrid',
      zoomId: tree.id,
      selectedId: '',
    };

    function valueFor(node) {
      if (!node) return 0;
      if (state.mode === 'tokens') return Math.max(0, num(node.tokens));
      if (state.mode === 'cost') return Math.max(0, num(node.costUnits));
      return Math.max(0, num(node.hybrid));
    }

    function unitLabel(node) {
      if (state.mode === 'tokens') {
        return fmtNum(node.tokens) + ' tokens';
      }
      if (state.mode === 'cost') {
        return fmtMoney(node.cost) + ' cost';
      }
      return fmtNum(node.hybrid) + ' hybrid units';
    }

    function colorForName(name, depth) {
      let hash = 0;
      const text = String(name || '');
      for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
      }
      const hue = Math.abs(hash) % 360;
      const sat = 62;
      const light = Math.max(32, 58 - depth * 2.4);
      return 'hsl(' + hue + ' ' + sat + '% ' + light + '%)';
    }

    function setMode(mode) {
      state.mode = mode;
      for (const key of Object.keys(modeButtons)) {
        modeButtons[key].classList.toggle('active', key === mode);
      }
      render();
    }

    function setSelected(node) {
      if (!node) {
        state.selectedId = '';
        selectedNameEl.textContent = 'Click a frame to inspect details.';
        selectedPathEl.textContent = '';
        selectedStatsEl.innerHTML = '';
        askAiBtn.disabled = true;
        return;
      }
      state.selectedId = node.id;
      selectedNameEl.textContent = node.name;
      selectedPathEl.textContent = node.path || '(root)';
      selectedStatsEl.innerHTML = [
        '<div class="stat"><div class="k">Active width</div><div class="v">' + esc(unitLabel(node)) + '</div></div>',
        '<div class="stat"><div class="k">Calls</div><div class="v">' + esc(fmtNum(node.calls)) + '</div></div>',
        '<div class="stat"><div class="k">Tokens</div><div class="v">' + esc(fmtNum(node.tokens)) + '</div></div>',
        '<div class="stat"><div class="k">Cost</div><div class="v">' + esc(fmtMoney(node.cost)) + '</div></div>',
        '<div class="stat"><div class="k">Duration</div><div class="v">' + esc(fmtMs(node.durationMs)) + '</div></div>',
        '<div class="stat"><div class="k">Children</div><div class="v">' + esc(fmtNum(Array.isArray(node.children) ? node.children.length : 0)) + '</div></div>',
      ].join('');
      askAiBtn.disabled = false;
    }

    function setStatus(text) {
      statusLineEl.textContent = text;
    }

    function depthOf(node) {
      const children = Array.isArray(node.children) ? node.children : [];
      if (!children.length) return 1;
      let maxDepth = 1;
      for (const child of children) {
        maxDepth = Math.max(maxDepth, 1 + depthOf(child));
      }
      return maxDepth;
    }

    function drawFlame() {
      const rootNode = index.get(state.zoomId) || tree;
      const rootValue = Math.max(1, valueFor(rootNode));
      const maxDepth = Math.min(14, depthOf(rootNode));
      const rowHeight = 24;
      const margin = { top: 10, left: 8, right: 8, bottom: 12 };
      const width = Math.max(640, svg.clientWidth || 840);
      const height = margin.top + margin.bottom + rowHeight * (maxDepth + 1);

      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.innerHTML = '';

      const make = (name) => document.createElementNS('http://www.w3.org/2000/svg', name);

      function drawNode(node, x, depth, totalWidth) {
        const value = valueFor(node);
        if (value <= 0 || totalWidth < 0.8) {
          return;
        }
        const y = margin.top + depth * rowHeight;
        const rect = make('rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(totalWidth));
        rect.setAttribute('height', String(rowHeight - 3));
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill', colorForName(node.name, depth));
        rect.setAttribute('stroke', node.id === state.selectedId ? '#e2e8f0' : '#081325');
        rect.setAttribute('stroke-width', node.id === state.selectedId ? '2' : '1');
        rect.style.cursor = 'pointer';
        rect.addEventListener('mouseenter', () => {
          setStatus(node.name + ' | ' + unitLabel(node) + ' | ' + fmtNum(node.calls) + ' calls');
        });
        rect.addEventListener('mouseleave', () => {
          setStatus('Hover for details. Click a frame to zoom.');
        });
        rect.addEventListener('click', () => {
          setSelected(node);
          state.zoomId = node.id;
          render();
        });
        const title = make('title');
        title.textContent = node.path + '\\n' + unitLabel(node) + '\\n' + fmtMoney(node.cost) + ' cost\\n' + fmtNum(node.tokens) + ' tokens';
        rect.appendChild(title);
        svg.appendChild(rect);

        if (totalWidth > 72) {
          const text = make('text');
          text.setAttribute('x', String(x + 6));
          text.setAttribute('y', String(y + 15));
          text.setAttribute('fill', '#ecfeff');
          text.setAttribute('font-size', '11');
          text.setAttribute('pointer-events', 'none');
          const label = node.name.length > 32 ? node.name.slice(0, 29) + '...' : node.name;
          text.textContent = label;
          svg.appendChild(text);
        }

        const children = Array.isArray(node.children) ? node.children : [];
        if (!children.length || depth >= maxDepth) {
          return;
        }

        let cursor = x;
        const denominator = Math.max(1, value);
        for (const child of children) {
          const childValue = valueFor(child);
          if (childValue <= 0) continue;
          const childWidth = totalWidth * (childValue / denominator);
          if (childWidth < 0.9) continue;
          drawNode(child, cursor, depth + 1, childWidth);
          cursor += childWidth;
        }
      }

      drawNode(rootNode, margin.left, 0, width - margin.left - margin.right);
    }

    function renderTraceList() {
      const rows = Array.isArray(payload.traceSummaries) ? payload.traceSummaries : [];
      if (!rows.length) {
        traceListEl.innerHTML = '<li>(no trace summaries available)</li>';
        return;
      }
      traceListEl.innerHTML = rows.map((row) => {
        return '<li>' +
          esc(String(row.traceId || '').slice(0, 16)) +
          ' | tokens ' + esc(fmtNum(row.tokens)) +
          ' | cost ' + esc(fmtMoney(row.cost)) +
          ' | spans ' + esc(fmtNum(row.spans)) +
        '</li>';
      }).join('');
    }

    function renderMeta() {
      chartMetaEl.textContent =
        fmtNum(payload.tracesIncluded) + ' traces, ' +
        fmtNum(payload.spanCount) + ' spans, ' +
        fmtNum(payload.filesUsed) + ' trace files';
    }

    function render() {
      drawFlame();
      renderMeta();
      renderTraceList();
      const rootNode = index.get(state.zoomId) || tree;
      if (!state.selectedId) {
        setSelected(rootNode);
      } else {
        const selected = index.get(state.selectedId);
        setSelected(selected || rootNode);
      }
      setStatus('Mode: ' + state.mode + '. Click bars to zoom. Reset to return to full tree.');
    }

    modeButtons.hybrid.addEventListener('click', () => setMode('hybrid'));
    modeButtons.tokens.addEventListener('click', () => setMode('tokens'));
    modeButtons.cost.addEventListener('click', () => setMode('cost'));
    resetZoomBtn.addEventListener('click', () => {
      state.zoomId = tree.id;
      render();
    });
    askAiBtn.addEventListener('click', () => {
      const node = index.get(state.selectedId);
      if (!node) return;
      const prompt = [
        'Analyze token/cost hotspot from flame graph:',
        '- Frame: ' + node.name,
        '- Path: ' + (node.path || '(root)'),
        '- Calls: ' + fmtNum(node.calls),
        '- Tokens: ' + fmtNum(node.tokens),
        '- Cost: ' + fmtMoney(node.cost),
        '- Duration: ' + fmtMs(node.durationMs),
        '- Current flame mode: ' + state.mode,
        '',
        'Please explain likely causes, suggest optimizations, and propose concrete code-level changes to reduce token/cost usage while keeping quality.',
      ].join('\\n');
      window.parent.postMessage({
        source: 'agentide-wow-widget',
        type: 'openChatWithPrompt',
        prompt,
      }, '*');
      askAiBtn.textContent = 'Prompt sent';
      setTimeout(() => {
        askAiBtn.textContent = 'Ask AI about this frame';
      }, 1300);
    });
    window.addEventListener('resize', () => render());

    render();
  </script>
</body>
</html>`;
}

function main() {
  const home = process.env.HOME || '';
  const tracesDir = process.env.AGENTIDE_TRACES_DIR || path.join(home, '.agent-hippo', 'analytics', 'traces');
  const chartDir = process.env.AGENTIDE_CHART_DIR || path.join(home, '.agent-hippo', 'analytics', 'views', 'global', '__all', '__all', 'charts');
  const outputPath = path.join(chartDir, 'token-cost-flamegraph-widget.html');
  fs.mkdirSync(chartDir, { recursive: true });

  if (isOutputDisabled('token-cost-flamegraph-widget.html')) {
    try {
      fs.unlinkSync(outputPath);
    } catch {
      // ignore missing file
    }
    return;
  }

  const { spans, filesUsed, traceCount, traceSummaries } = loadSpans(tracesDir);
  if (!spans.length) {
    fs.writeFileSync(outputPath, buildFallbackHtml('No OTEL spans found in analytics traces.'), 'utf8');
    return;
  }

  const aggregated = buildAggregatedTree(spans);
  if (!aggregated || aggregated.totalHybrid <= 0) {
    fs.writeFileSync(outputPath, buildFallbackHtml('Trace data loaded, but no token/cost metrics were found.'), 'utf8');
    return;
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    filesUsed,
    spanCount: spans.length,
    tracesIncluded: traceCount,
    totals: {
      tokens: aggregated.totalTokens,
      cost: aggregated.totalCost,
      hybridUnits: aggregated.totalHybrid,
    },
    traceSummaries,
    tree: serializeTree(aggregated),
  };

  fs.writeFileSync(outputPath, buildHtml(payload), 'utf8');
}

main();
