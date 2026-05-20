#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_POINTS = 120;
const MAX_COMPLEXITY_FILES = 260;
const MAX_RECENT_COMMITS = 260;
const MAX_COMMITS_PER_FILE = 6;
const CHURN_LOOKBACK = '180 days ago';

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.rb', '.php', '.cs', '.cpp', '.cc', '.cxx', '.c',
  '.h', '.hpp', '.hh', '.scala', '.sql', '.sh', '.zsh',
  '.bash', '.lua', '.json', '.yaml', '.yml', '.toml',
  '.md', '.css', '.scss', '.sass', '.less', '.html',
  '.vue', '.svelte',
]);

const IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  'vendor',
  'tmp',
  'temp',
]);

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

function runGit(args, cwd, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function resolveRepoRoot() {
  const candidates = [
    process.env.AGENTIDE_WORKSPACE_ROOT || '',
    process.env.PWD || '',
    process.cwd(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const root = runGit(['-C', candidate, 'rev-parse', '--show-toplevel'], candidate).trim();
    if (root) {
      return root;
    }
  }

  const fallback = runGit(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  return fallback || '';
}

function normalizeGitPath(rawPath) {
  let normalized = String(rawPath || '').trim();
  if (!normalized) {
    return '';
  }

  normalized = normalized.replace(/^"+|"+$/g, '');
  normalized = normalized.replace(/^\.\//, '');
  normalized = normalized.replace(/\\/g, '/');
  if (normalized.includes('=>')) {
    normalized = normalized.replace(/\{([^{}]*)=>([^{}]*)\}/g, (_match, _left, right) => right);
    const parts = normalized.split('=>');
    normalized = parts[parts.length - 1].trim();
  }
  return normalized.replace(/^"+|"+$/g, '').trim();
}

function isLikelyCodeFile(relativePath) {
  const normalized = String(relativePath || '').trim();
  if (!normalized) {
    return false;
  }
  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    if (IGNORED_SEGMENTS.has(part)) {
      return false;
    }
  }
  const ext = path.extname(normalized).toLowerCase();
  if (!ext) {
    return false;
  }
  return CODE_EXTENSIONS.has(ext);
}

function toSafeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function collectChurn(repoRoot) {
  const output = runGit(
    ['log', '--since', CHURN_LOOKBACK, '--numstat', '--format=__COMMIT__%H', '--'],
    repoRoot,
    { maxBuffer: 80 * 1024 * 1024 },
  );
  if (!output.trim()) {
    return [];
  }

  /** @type {Map<string, { filePath: string, commitIds: Set<string>, commits: number, churn: number, additions: number, deletions: number }>} */
  const byFile = new Map();
  let currentCommitId = '';

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith('__COMMIT__')) {
      currentCommitId = line.slice('__COMMIT__'.length).trim();
      continue;
    }
    if (!currentCommitId) {
      continue;
    }

    const columns = line.split('\t');
    if (columns.length < 3) {
      continue;
    }
    const additions = toSafeNumber(columns[0]);
    const deletions = toSafeNumber(columns[1]);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
      continue;
    }

    const filePath = normalizeGitPath(columns.slice(2).join('\t'));
    if (!filePath || !isLikelyCodeFile(filePath)) {
      continue;
    }

    let entry = byFile.get(filePath);
    if (!entry) {
      entry = {
        filePath,
        commitIds: new Set(),
        commits: 0,
        churn: 0,
        additions: 0,
        deletions: 0,
      };
      byFile.set(filePath, entry);
    }

    if (!entry.commitIds.has(currentCommitId)) {
      entry.commitIds.add(currentCommitId);
      entry.commits += 1;
    }
    entry.churn += additions + deletions;
    entry.additions += additions;
    entry.deletions += deletions;
  }

  return [...byFile.values()]
    .map((entry) => ({
      filePath: entry.filePath,
      commitCount: entry.commits,
      churn: entry.churn,
      additions: entry.additions,
      deletions: entry.deletions,
    }))
    .filter((entry) => entry.commitCount > 0 && entry.churn > 0);
}

function computeComplexity(repoRoot, relativeFilePath) {
  const absolutePath = path.join(repoRoot, relativeFilePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  let text;
  try {
    text = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  let loc = 0;
  let decisionPoints = 0;

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) {
      continue;
    }
    loc += 1;
    decisionPoints += (line.match(/\b(if|else if|for|while|case|catch|switch|when)\b/g) || []).length;
    decisionPoints += (line.match(/&&|\|\||\?/g) || []).length;
  }

  if (loc === 0) {
    return null;
  }

  const fileSize = Buffer.byteLength(text, 'utf8');
  const complexity = Math.max(1, loc + decisionPoints * 6);
  return {
    loc,
    decisionPoints,
    fileSize,
    complexity,
  };
}

function collectRecentCommitsByFile(repoRoot, targetFiles) {
  if (!targetFiles.size) {
    return new Map();
  }
  const output = runGit(
    [
      'log',
      '-n',
      String(MAX_RECENT_COMMITS),
      '--date=short',
      '--pretty=format:__COMMIT__%h|%ad|%s',
      '--name-only',
      '--',
    ],
    repoRoot,
    { maxBuffer: 36 * 1024 * 1024 },
  );
  /** @type {Map<string, Array<{ hash: string, date: string, subject: string }>>} */
  const perFile = new Map();
  /** @type {Map<string, Set<string>>} */
  const seenHashPerFile = new Map();
  let currentCommit = null;

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith('__COMMIT__')) {
      const body = line.slice('__COMMIT__'.length);
      const [hash = '', date = '', ...subjectParts] = body.split('|');
      currentCommit = {
        hash: hash.trim(),
        date: date.trim(),
        subject: subjectParts.join('|').trim(),
      };
      continue;
    }
    if (!currentCommit) {
      continue;
    }
    const filePath = normalizeGitPath(line);
    if (!filePath || !targetFiles.has(filePath)) {
      continue;
    }

    let rows = perFile.get(filePath);
    if (!rows) {
      rows = [];
      perFile.set(filePath, rows);
    }
    let seen = seenHashPerFile.get(filePath);
    if (!seen) {
      seen = new Set();
      seenHashPerFile.set(filePath, seen);
    }
    if (seen.has(currentCommit.hash) || rows.length >= MAX_COMMITS_PER_FILE) {
      continue;
    }
    seen.add(currentCommit.hash);
    rows.push({
      hash: currentCommit.hash,
      date: currentCommit.date,
      subject: currentCommit.subject,
    });
  }
  return perFile;
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

function buildFallbackHtml(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hotspot Analysis</title></head><body style="font-family:ui-sans-serif,system-ui;background:#0f111a;color:#e5e7eb;margin:0;padding:20px;"><h2 style="margin:0 0 8px;">Hotspot Analysis</h2><p style="opacity:.85;">${message}</p></body></html>`;
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
  <title>Hotspot Analysis</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #101a2f;
      --soft: #16243c;
      --text: #e2e8f0;
      --muted: #93a4be;
      --border: #223452;
      --accent: #38bdf8;
      --warn: #f59e0b;
      --bad: #ef4444;
      --good: #10b981;
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
      grid-template-columns: minmax(580px, 1fr) minmax(280px, 360px);
      min-height: 95vh;
      gap: 10px;
      padding: 12px;
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
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .title {
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.1px;
    }
    .pill {
      border: 1px solid #265483;
      color: #bae6fd;
      background: #132846;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      white-space: nowrap;
    }
    .meta {
      color: var(--muted);
      font-size: 11px;
      margin-top: 2px;
    }
    .plot-wrap {
      position: relative;
      height: min(70vh, 760px);
      padding: 8px;
    }
    svg {
      width: 100%;
      height: 100%;
      display: block;
      background: #0a1324;
      border-radius: 10px;
      border: 1px solid #1e2f4b;
    }
    .hint {
      position: absolute;
      right: 12px;
      bottom: 12px;
      color: var(--muted);
      font-size: 11px;
      background: rgba(11, 18, 32, 0.78);
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 6px;
      padding: 5px 7px;
    }
    .side {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 0;
    }
    .block {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .block:last-child { border-bottom: none; }
    .file-name {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      word-break: break-word;
      color: #dbeafe;
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
      min-width: 0;
    }
    .stat .k {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .stat .v {
      font-size: 13px;
      font-weight: 700;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .recent {
      margin: 0;
      padding: 0;
      list-style: none;
      max-height: 38vh;
      overflow: auto;
      display: grid;
      gap: 7px;
    }
    .recent li {
      border: 1px solid #273a59;
      background: #11203a;
      border-radius: 8px;
      padding: 7px;
    }
    .recent .h {
      color: #93c5fd;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      margin-right: 6px;
    }
    .recent .d {
      color: var(--muted);
      font-size: 10px;
    }
    .recent .s {
      margin-top: 4px;
      font-size: 12px;
      color: #dbeafe;
      line-height: 1.35;
      word-break: break-word;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid var(--border);
    }
    button {
      border: 1px solid #315685;
      background: #122642;
      color: #dbeafe;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    button:hover { border-color: #60a5fa; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .risk-high { color: #fca5a5; }
    .risk-medium { color: #fcd34d; }
    .risk-low { color: #86efac; }
    @media (max-width: 1080px) {
      .root { grid-template-columns: 1fr; }
      .plot-wrap { height: min(58vh, 560px); }
      .recent { max-height: 28vh; }
    }
  </style>
</head>
<body>
  <div class="root">
    <section class="card">
      <div class="head">
        <div>
          <div class="title">Hotspot Analysis (Complexity x Churn)</div>
          <div class="meta" id="chart-meta"></div>
        </div>
        <span class="pill">Interactive SVG</span>
      </div>
      <div class="plot-wrap" id="plot-wrap">
        <svg id="hotspot-chart" role="img" aria-label="Hotspot analysis scatter plot"></svg>
        <div class="hint">Top-right quadrant is highest risk. Click any bubble for details.</div>
      </div>
    </section>

    <aside class="card side">
      <div class="block">
        <div class="title">Selected File</div>
        <div class="file-name" id="selected-file">Pick a bubble to inspect.</div>
        <div class="stats" id="selected-stats"></div>
      </div>
      <div class="block">
        <div class="title">Recent Changes</div>
        <ul id="recent-list" class="recent"></ul>
      </div>
      <div class="actions">
        <button id="ask-ai-btn" type="button" disabled>Ask AI to Refactor</button>
      </div>
    </aside>
  </div>

  <script>
    const payload = ${safeJson};
    const points = Array.isArray(payload.points) ? payload.points : [];
    const chartMetaEl = document.getElementById('chart-meta');
    const chartEl = document.getElementById('hotspot-chart');
    const selectedFileEl = document.getElementById('selected-file');
    const selectedStatsEl = document.getElementById('selected-stats');
    const recentListEl = document.getElementById('recent-list');
    const askAiBtn = document.getElementById('ask-ai-btn');

    const esc = (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    const num = (value) => Number(value || 0);
    const fmt = (value) => num(value).toLocaleString();
    const fmtRisk = (value) => num(value).toFixed(2);

    const state = {
      selectedPath: points[0] ? points[0].filePath : '',
    };

    function colorForRisk(point) {
      const risk = num(point.risk);
      if (risk >= payload.riskThresholds.high) {
        return '#ef4444';
      }
      if (risk >= payload.riskThresholds.medium) {
        return '#f59e0b';
      }
      return '#10b981';
    }

    function riskClass(point) {
      const risk = num(point.risk);
      if (risk >= payload.riskThresholds.high) {
        return 'risk-high';
      }
      if (risk >= payload.riskThresholds.medium) {
        return 'risk-medium';
      }
      return 'risk-low';
    }

    function byPath(path) {
      return points.find((point) => point.filePath === path) || null;
    }

    function postAskAi(point) {
      if (!point) return;
      const recent = Array.isArray(point.recent) ? point.recent : [];
      const commitLines = recent.map((row) => '- ' + row.hash + ' (' + row.date + '): ' + row.subject).join('\\n');
      const prompt = [
        'Refactor hotspot candidate: ' + point.filePath,
        '',
        'Hotspot metrics:',
        '- Changes in last 180 days: ' + fmt(point.commitCount) + ' commits',
        '- Churn: ' + fmt(point.churn) + ' lines changed (' + fmt(point.additions) + ' added, ' + fmt(point.deletions) + ' deleted)',
        '- Complexity score: ' + fmt(point.complexity) + ' (LOC ' + fmt(point.loc) + ', decision points ' + fmt(point.decisionPoints) + ')',
        '- Risk score: ' + fmtRisk(point.risk),
        '',
        'Recent changes:',
        commitLines || '- (no recent commit samples)',
        '',
        'Please propose a safe, incremental refactor plan and generate the first concrete patch for this file.',
      ].join('\\n');
      window.parent.postMessage({
        source: 'agentide-wow-widget',
        type: 'openChatWithPrompt',
        prompt,
      }, '*');
      askAiBtn.textContent = 'Prompt sent';
      setTimeout(() => {
        askAiBtn.textContent = 'Ask AI to Refactor';
      }, 1300);
    }

    function renderDetails() {
      const point = byPath(state.selectedPath);
      if (!point) {
        selectedFileEl.textContent = 'Pick a bubble to inspect.';
        selectedStatsEl.innerHTML = '';
        recentListEl.innerHTML = '<li><span class="d">No file selected.</span></li>';
        askAiBtn.disabled = true;
        return;
      }

      selectedFileEl.textContent = point.filePath;
      selectedStatsEl.innerHTML = [
        '<div class="stat"><div class="k">Commits</div><div class="v">' + esc(fmt(point.commitCount)) + '</div></div>',
        '<div class="stat"><div class="k">Churn</div><div class="v">' + esc(fmt(point.churn)) + '</div></div>',
        '<div class="stat"><div class="k">Complexity</div><div class="v">' + esc(fmt(point.complexity)) + '</div></div>',
        '<div class="stat"><div class="k">LOC</div><div class="v">' + esc(fmt(point.loc)) + '</div></div>',
        '<div class="stat"><div class="k">Decision Points</div><div class="v">' + esc(fmt(point.decisionPoints)) + '</div></div>',
        '<div class="stat"><div class="k">Risk</div><div class="v ' + riskClass(point) + '">' + esc(fmtRisk(point.risk)) + '</div></div>',
      ].join('');

      const recent = Array.isArray(point.recent) ? point.recent : [];
      if (!recent.length) {
        recentListEl.innerHTML = '<li><span class="d">No recent commits in sampled history.</span></li>';
      } else {
        recentListEl.innerHTML = recent.map((row) => {
          return '<li>' +
            '<span class="h">' + esc(row.hash) + '</span>' +
            '<span class="d">' + esc(row.date) + '</span>' +
            '<div class="s">' + esc(row.subject) + '</div>' +
          '</li>';
        }).join('');
      }

      askAiBtn.disabled = false;
    }

    function renderScatter() {
      const width = Math.max(420, chartEl.clientWidth || 720);
      const height = Math.max(360, chartEl.clientHeight || 500);
      const margin = { top: 28, right: 26, bottom: 42, left: 60 };
      const innerWidth = Math.max(200, width - margin.left - margin.right);
      const innerHeight = Math.max(140, height - margin.top - margin.bottom);

      chartEl.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      chartEl.innerHTML = '';

      const maxX = Math.max(1, ...points.map((point) => num(point.commitCount)));
      const maxY = Math.max(1, ...points.map((point) => num(point.complexity)));
      const minLoc = Math.min(...points.map((point) => num(point.loc)));
      const maxLoc = Math.max(...points.map((point) => num(point.loc)));
      const xMid = num(payload.quadrants.x);
      const yMid = num(payload.quadrants.y);

      const sx = (x) => margin.left + (Math.max(0, x) / maxX) * innerWidth;
      const sy = (y) => margin.top + innerHeight - (Math.max(0, y) / maxY) * innerHeight;
      const sr = (loc) => {
        if (maxLoc <= minLoc) return 8;
        const t = (loc - minLoc) / Math.max(1, maxLoc - minLoc);
        return 5 + t * 13;
      };

      const make = (name) => document.createElementNS('http://www.w3.org/2000/svg', name);

      const bg = make('rect');
      bg.setAttribute('x', String(margin.left));
      bg.setAttribute('y', String(margin.top));
      bg.setAttribute('width', String(innerWidth));
      bg.setAttribute('height', String(innerHeight));
      bg.setAttribute('fill', '#081224');
      bg.setAttribute('stroke', '#223452');
      chartEl.appendChild(bg);

      const xAxis = make('line');
      xAxis.setAttribute('x1', String(margin.left));
      xAxis.setAttribute('y1', String(margin.top + innerHeight));
      xAxis.setAttribute('x2', String(margin.left + innerWidth));
      xAxis.setAttribute('y2', String(margin.top + innerHeight));
      xAxis.setAttribute('stroke', '#3a4f72');
      chartEl.appendChild(xAxis);

      const yAxis = make('line');
      yAxis.setAttribute('x1', String(margin.left));
      yAxis.setAttribute('y1', String(margin.top));
      yAxis.setAttribute('x2', String(margin.left));
      yAxis.setAttribute('y2', String(margin.top + innerHeight));
      yAxis.setAttribute('stroke', '#3a4f72');
      chartEl.appendChild(yAxis);

      const xMidLine = make('line');
      xMidLine.setAttribute('x1', String(sx(xMid)));
      xMidLine.setAttribute('y1', String(margin.top));
      xMidLine.setAttribute('x2', String(sx(xMid)));
      xMidLine.setAttribute('y2', String(margin.top + innerHeight));
      xMidLine.setAttribute('stroke', '#4b5563');
      xMidLine.setAttribute('stroke-dasharray', '4 4');
      chartEl.appendChild(xMidLine);

      const yMidLine = make('line');
      yMidLine.setAttribute('x1', String(margin.left));
      yMidLine.setAttribute('y1', String(sy(yMid)));
      yMidLine.setAttribute('x2', String(margin.left + innerWidth));
      yMidLine.setAttribute('y2', String(sy(yMid)));
      yMidLine.setAttribute('stroke', '#4b5563');
      yMidLine.setAttribute('stroke-dasharray', '4 4');
      chartEl.appendChild(yMidLine);

      const quadrant = make('text');
      quadrant.setAttribute('x', String(sx(xMid) + 8));
      quadrant.setAttribute('y', String(sy(yMid) - 8));
      quadrant.setAttribute('fill', '#fca5a5');
      quadrant.setAttribute('font-size', '11');
      quadrant.textContent = 'Highest risk quadrant';
      chartEl.appendChild(quadrant);

      points.forEach((point) => {
        const group = make('g');
        group.style.cursor = 'pointer';

        const circle = make('circle');
        circle.setAttribute('cx', String(sx(num(point.commitCount))));
        circle.setAttribute('cy', String(sy(num(point.complexity))));
        circle.setAttribute('r', String(sr(num(point.loc))));
        circle.setAttribute('fill', colorForRisk(point));
        circle.setAttribute('fill-opacity', point.filePath === state.selectedPath ? '0.9' : '0.6');
        circle.setAttribute('stroke', point.filePath === state.selectedPath ? '#e2e8f0' : '#0b1220');
        circle.setAttribute('stroke-width', point.filePath === state.selectedPath ? '2.2' : '1');
        const title = make('title');
        title.textContent = point.filePath + ' | commits: ' + fmt(point.commitCount) + ', complexity: ' + fmt(point.complexity) + ', risk: ' + fmtRisk(point.risk);
        circle.appendChild(title);

        group.appendChild(circle);
        group.addEventListener('click', () => {
          state.selectedPath = point.filePath;
          renderDetails();
          renderScatter();
        });
        chartEl.appendChild(group);
      });

      const xLabel = make('text');
      xLabel.setAttribute('x', String(margin.left + innerWidth / 2));
      xLabel.setAttribute('y', String(height - 12));
      xLabel.setAttribute('text-anchor', 'middle');
      xLabel.setAttribute('fill', '#9fb1cc');
      xLabel.setAttribute('font-size', '11');
      xLabel.textContent = 'Change Frequency (commits over last 180 days)';
      chartEl.appendChild(xLabel);

      const yLabel = make('text');
      yLabel.setAttribute('x', '14');
      yLabel.setAttribute('y', String(margin.top + innerHeight / 2));
      yLabel.setAttribute('transform', 'rotate(-90 14 ' + (margin.top + innerHeight / 2) + ')');
      yLabel.setAttribute('text-anchor', 'middle');
      yLabel.setAttribute('fill', '#9fb1cc');
      yLabel.setAttribute('font-size', '11');
      yLabel.textContent = 'Complexity Score';
      chartEl.appendChild(yLabel);
    }

    function renderMeta() {
      chartMetaEl.textContent = points.length + ' files from ' + (payload.repoName || 'repository') + ' | median commits ' + fmt(payload.quadrants.x) + ', median complexity ' + fmt(payload.quadrants.y);
    }

    askAiBtn.addEventListener('click', () => {
      postAskAi(byPath(state.selectedPath));
    });

    renderMeta();
    renderDetails();
    renderScatter();
    window.addEventListener('resize', () => {
      renderScatter();
    });
  </script>
</body>
</html>`;
}

function main() {
  const home = process.env.HOME || '';
  const chartDir = process.env.AGENTIDE_CHART_DIR || path.join(home, '.agent-hippo', 'analytics', 'views', 'global', '__all', '__all', 'charts');
  const outputPath = path.join(chartDir, 'hotspot-analysis-widget.html');
  fs.mkdirSync(chartDir, { recursive: true });

  if (isOutputDisabled('hotspot-analysis-widget.html')) {
    try {
      fs.unlinkSync(outputPath);
    } catch {
      // ignore missing file
    }
    return;
  }

  const repoRoot = resolveRepoRoot();
  if (!repoRoot || !fs.existsSync(path.join(repoRoot, '.git'))) {
    fs.writeFileSync(outputPath, buildFallbackHtml('No Git repository detected for this workspace.'), 'utf8');
    return;
  }

  const churnRows = collectChurn(repoRoot)
    .sort((a, b) => b.commitCount - a.commitCount || b.churn - a.churn)
    .slice(0, MAX_COMPLEXITY_FILES);

  if (!churnRows.length) {
    fs.writeFileSync(outputPath, buildFallbackHtml('Not enough recent git churn data to build hotspots.'), 'utf8');
    return;
  }

  const points = [];
  for (const row of churnRows) {
    const complexity = computeComplexity(repoRoot, row.filePath);
    if (!complexity) {
      continue;
    }
    const risk = Math.log1p(row.commitCount) * Math.log1p(complexity.complexity);
    points.push({
      filePath: row.filePath,
      commitCount: row.commitCount,
      churn: row.churn,
      additions: row.additions,
      deletions: row.deletions,
      loc: complexity.loc,
      decisionPoints: complexity.decisionPoints,
      complexity: complexity.complexity,
      fileSize: complexity.fileSize,
      risk,
    });
  }

  if (!points.length) {
    fs.writeFileSync(outputPath, buildFallbackHtml('No analyzable code files found for hotspot analysis.'), 'utf8');
    return;
  }

  points.sort((a, b) => b.risk - a.risk || b.commitCount - a.commitCount || b.complexity - a.complexity);
  const reduced = points.slice(0, MAX_POINTS);

  const recentByFile = collectRecentCommitsByFile(
    repoRoot,
    new Set(reduced.map((point) => point.filePath)),
  );
  for (const point of reduced) {
    point.recent = recentByFile.get(point.filePath) || [];
  }

  const xValues = reduced.map((point) => point.commitCount).filter((value) => Number.isFinite(value) && value > 0);
  const yValues = reduced.map((point) => point.complexity).filter((value) => Number.isFinite(value) && value > 0);
  const risks = reduced.map((point) => point.risk).sort((a, b) => a - b);
  const mediumThreshold = risks[Math.max(0, Math.floor(risks.length * 0.55) - 1)] || 0;
  const highThreshold = risks[Math.max(0, Math.floor(risks.length * 0.8) - 1)] || mediumThreshold;

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoRoot,
    repoName: path.basename(repoRoot),
    lookback: CHURN_LOOKBACK,
    quadrants: {
      x: Math.round(median(xValues)),
      y: Math.round(median(yValues)),
    },
    riskThresholds: {
      medium: mediumThreshold,
      high: highThreshold,
    },
    points: reduced,
  };

  fs.writeFileSync(outputPath, buildHtml(payload), 'utf8');
}

main();
