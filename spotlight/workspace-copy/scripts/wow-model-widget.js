#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findDuckdb } = require('./duckdbLocator');

function sqlLiteral(value) {
	return `'${String(value || '').replace(/'/g, "''")}'`;
}

function getDuckDbRuntime() {
	const memoryMb = Math.max(64, Number(process.env.AGENTIDE_DUCKDB_MEMORY_LIMIT_MB || '256'));
	const threads = Math.max(1, Number(process.env.AGENTIDE_DUCKDB_THREADS || '2'));
	const tempDir = (process.env.AGENTIDE_DUCKDB_TEMP_DIRECTORY || '').trim();
	const timeoutSeconds = Math.max(5, Number(process.env.AGENTIDE_DUCKDB_QUERY_TIMEOUT_SECONDS || '30'));
	return {
		memoryMb,
		threads,
		tempDir,
		timeoutMs: timeoutSeconds * 1000,
	};
}

function buildRuntimeSettingsSql(runtime) {
	const lines = [
		`SET memory_limit='${runtime.memoryMb}MB';`,
		`SET threads=${runtime.threads};`,
		'SET preserve_insertion_order=false;',
	];
	if (runtime.tempDir) {
		lines.push(`SET temp_directory=${sqlLiteral(runtime.tempDir)};`);
	}
	return lines.join('\n');
}

function runQuery(duckdbPath, dbPath, sql, runtime) {
	try {
		const fullSql = `${buildRuntimeSettingsSql(runtime)}\n${sql}`;
		const stdout = execFileSync(duckdbPath, [dbPath, '-json', '-c', fullSql], {
			encoding: 'utf8',
			maxBuffer: 10 * 1024 * 1024,
			timeout: runtime.timeoutMs,
		});
		const trimmed = stdout.trim();
		return trimmed ? JSON.parse(trimmed) : [];
	} catch {
		return [];
	}
}

function handleFromSession(sessionId) {
	const raw = String(sessionId || '').trim();
	if (!raw) {
		return 'unknown';
	}
	return raw.split('-', 1)[0].slice(0, 8);
}

function buildFallbackHtml(message) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Model Cost + Session Explorer</title></head><body style="font-family: ui-sans-serif, system-ui; background:#0f111a; color:#e5e7eb; margin:0; padding:20px;"><h2 style="margin:0 0 8px;">Model Cost + Session Explorer</h2><p style="opacity:.8;">${message}</p></body></html>`;
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

function main() {
	const home = process.env.HOME || '';
	const chartDir = process.env.AGENTIDE_CHART_DIR || path.join(home, '.agent-hippo', 'analytics', 'views', 'global', '__all', '__all', 'charts');
	const indexDbPath = (process.env.AGENTIDE_INDEX_DB_PATH || path.join(home, '.agent-hippo', 'analytics', 'traces', 'analytics.duckdb')).trim();
	fs.mkdirSync(chartDir, { recursive: true });
	const outputPath = path.join(chartDir, 'wow-model-widget.html');
	if (isOutputDisabled('wow-model-widget.html')) {
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
	if (!indexDbPath || !fs.existsSync(indexDbPath)) {
		fs.writeFileSync(outputPath, buildFallbackHtml('Indexed analytics DB not found yet. Wait for indexing to complete and refresh.'), 'utf8');
		return;
	}

	const runtime = getDuckDbRuntime();
	const models = runQuery(duckdb, indexDbPath, `
SELECT
	COALESCE(model, 'unknown') as model,
	COALESCE(SUM(cost), 0) as cost,
	COALESCE(AVG(duration_ms), 0) as latency_ms,
	COUNT(*) as requests
FROM spans
WHERE cost IS NOT NULL
GROUP BY model
ORDER BY cost DESC
LIMIT 8;
`, runtime);
	const sessions = runQuery(duckdb, indexDbPath, `
SELECT
	session_id,
	COALESCE(SUM(cost), 0) as cost,
	COUNT(*) as requests
FROM spans
WHERE cost IS NOT NULL
	AND session_id IS NOT NULL
GROUP BY session_id
ORDER BY cost DESC
LIMIT 6;
`, runtime).map((row) => ({ ...row, handle: handleFromSession(row.session_id) }));

	const sessionsByModel = runQuery(duckdb, indexDbPath, `
WITH session_costs AS (
	SELECT
		COALESCE(model, 'unknown') as model,
		session_id,
		COALESCE(SUM(cost), 0) as cost,
		COUNT(*) as requests
	FROM spans
	WHERE cost IS NOT NULL
		AND session_id IS NOT NULL
	GROUP BY model, session_id
),
ranked AS (
	SELECT
		model,
		session_id,
		cost,
		requests,
		ROW_NUMBER() OVER (PARTITION BY model ORDER BY cost DESC) as row_rank
	FROM session_costs
)
SELECT model, session_id, cost, requests
FROM ranked
WHERE row_rank <= 8
ORDER BY cost DESC
LIMIT 64;
`, runtime).map((row) => ({ ...row, handle: handleFromSession(row.session_id) }));

	const payload = { models, sessions, sessionsByModel };
	const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Model Cost + Session Explorer</title>
<style>
body{margin:0;background:#0b1220;color:#e2e8f0;font:13px/1.4 ui-sans-serif,system-ui}.wrap{padding:14px}.title{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#132341;color:#93c5fd;border:1px solid #1d4ed8}.hint{font-size:11px;color:#94a3b8;margin:0 0 8px}.rows{display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:12px}.row{background:#11182b;border:1px solid #1f2937;border-radius:10px;padding:8px;cursor:pointer;transition:background-color .12s,border-color .12s}.row:hover{background:#172033}.row.active{border-color:#3b82f6;background:#14233d}.top{display:flex;justify-content:space-between;gap:10px}.name{font-weight:600;max-width:56%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:11px;color:#94a3b8}.bar{margin-top:6px;height:6px;background:#1f2937;border-radius:999px;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,#22d3ee,#3b82f6)}.table{background:#0f172a;border:1px solid #1f2937;border-radius:10px;overflow:hidden}.th,.tr{display:grid;grid-template-columns:1.3fr .8fr .8fr;gap:8px;padding:8px 10px}.th{font-size:11px;color:#94a3b8;background:#111827}.tr{border-top:1px solid #1f2937}.tr{cursor:pointer;transition:background-color .12s}.tr:hover{background:#172033}.tr.active{background:#1d2a47}.copy-status{margin-top:8px;font-size:11px;color:#93c5fd;min-height:14px}
</style></head>
<body><div class="wrap">
<div class="title"><div style="font-weight:700">Model Cost + Session Explorer</div><div class="pill">Interactive HTML</div></div>
<div id="filter-hint" class="hint">Click a model bar to filter sessions. Click again to clear. Then click a session row to copy full session ID.</div>
<div id="model-rows" class="rows"></div>
<div class="table"><div class="th"><div>Top Session</div><div>Cost</div><div>Requests</div></div><div id="session-rows"></div></div>
<div id="copy-status" class="copy-status"></div>
</div>
<script>
const data=${JSON.stringify(payload)};
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const maxCost=Math.max(0.000001,...(data.models||[]).map(m=>Number(m.cost||0)));
const modelRows=document.getElementById('model-rows');
const sessionRows=document.getElementById('session-rows');
const copyStatus=document.getElementById('copy-status');
const filterHint=document.getElementById('filter-hint');
let copiedTimer=null;
let activeModel='';
function renderSessions(){const pool=activeModel?(data.sessionsByModel||[]).filter((s)=>String(s.model||'unknown')===activeModel):(data.sessions||[]);if(!pool.length){sessionRows.innerHTML='<div class="tr"><div>n/a</div><div>$0.0000</div><div>0</div></div>';return;}sessionRows.innerHTML=pool.map((s)=>'<div class="tr" data-session-id="'+esc(s.session_id)+'" title="Click to copy '+esc(s.session_id)+'"><div>'+esc(s.handle||'unknown')+'</div><div>$'+Number(s.cost||0).toFixed(4)+'</div><div>'+Number(s.requests||0)+'</div></div>').join('');sessionRows.querySelectorAll('.tr').forEach((row)=>{row.addEventListener('click',()=>{const sid=row.getAttribute('data-session-id')||'';if(!sid){return;}sessionRows.querySelectorAll('.tr.active').forEach((n)=>n.classList.remove('active'));row.classList.add('active');window.parent.postMessage({source:'agentide-wow-widget',type:'copySessionId',sessionId:sid},'*');if(copyStatus){copyStatus.textContent='Copied '+sid;clearTimeout(copiedTimer);copiedTimer=setTimeout(()=>{copyStatus.textContent='';},1400);}});});}
function setActiveModel(model){activeModel=activeModel===model?'':model;modelRows.querySelectorAll('.row').forEach((row)=>{row.classList.toggle('active',row.getAttribute('data-model')===activeModel);});if(filterHint){filterHint.textContent=activeModel?('Filtered by model: '+activeModel+' (click active bar again to clear)'):'Click a model bar to filter sessions. Click again to clear. Then click a session row to copy full session ID.';}renderSessions();}
modelRows.innerHTML=(data.models||[]).map((m)=>{const model=String(m.model||'unknown');const c=Number(m.cost||0),w=Math.max(2,Math.round((c/maxCost)*100));return '<div class="row" data-model="'+esc(model)+'" title="Filter sessions by '+esc(model)+'"><div class="top"><div class="name" title="'+esc(model)+'">'+esc(model)+'</div><div class="meta">$'+c.toFixed(4)+' · '+Math.round(Number(m.latency_ms||0))+'ms · '+Number(m.requests||0)+' req</div></div><div class="bar"><div class="fill" style="width:'+w+'%"></div></div></div>';}).join('');
modelRows.querySelectorAll('.row').forEach((row)=>{row.addEventListener('click',()=>{const model=row.getAttribute('data-model')||'';if(model){setActiveModel(model);}});});
renderSessions();
</script>
</body></html>`;
	fs.writeFileSync(outputPath, html, 'utf8');
}

main();
