#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* Data contract for agent-fleet.json: extensions/agentide/src/analytics/dashboard/FLEET_DATA_CONTRACT.md */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const EXPORT_FILE = 'agent-fleet.json';
const OUTPUT_HTML = 'agent-fleet.html';
const OUTPUT_CSV = 'agent-fleet.csv';

function safeNumber(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : 0;
}

function readFleetExport(exportDir) {
	const exportPath = path.join(exportDir, EXPORT_FILE);
	try {
		fs.mkdirSync(exportDir, { recursive: true });
		const raw = fs.readFileSync(exportPath, 'utf8');
		const parsed = JSON.parse(raw);
		const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
		return {
			ok: true,
			exportPath,
			payload: {
				generatedAt: parsed?.generatedAt || '',
				totals: parsed?.totals || {},
				sessions,
			},
		};
	} catch (error) {
		// Missing file (ENOENT) = no data yet; return empty payload so dashboard still renders
		const isEnoent = error && (error.code === 'ENOENT' || (error.message && error.message.includes('ENOENT')));
		return {
			ok: isEnoent,
			exportPath,
			error: error instanceof Error ? error.message : String(error),
			payload: {
				generatedAt: new Date().toISOString(),
				totals: { sessions: 0, activeAgents: 0, inProgress: 0, scheduled: 0, done: 0, tokens: 0, turns: 0 },
				sessions: [],
			},
		};
	}
}

function statusRank(status) {
	if (status === 'in_progress') return 0;
	if (status === 'scheduled') return 1;
	if (status === 'done') return 2;
	return 3;
}

function escapeHtml(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function writeIfChanged(filePath, content) {
	try {
		const existing = fs.readFileSync(filePath, 'utf8');
		if (existing === content) {
			return false;
		}
	} catch (error) {
		// ENOENT = first write; proceed.
	}
	fs.writeFileSync(filePath, content, 'utf8');
	return true;
}

function writeCsv(exportDir, sessions) {
	const rows = [
		['session_id', 'agent_id', 'status', 'started_at', 'ended_at', 'tokens', 'turns', 'model', 'channel_type', 'channel_target', 'agent_pack', 'engine'],
		...sessions.map((session) => [
			session.sessionId || '',
			session.agentId || '',
			session.status || '',
			session.startedAt || '',
			session.endedAt || '',
			String(safeNumber(session.totalTokens)),
			String(safeNumber(session.turns)),
			session.model || 'unknown',
			session.channelType || 'none',
			session.channelTarget || '',
			session.agentPack || '',
			session.engine || '',
		]),
	];
	const content = rows
		.map((columns) => columns
			.map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
			.join(','))
		.join('\n');
	return writeIfChanged(path.join(exportDir, OUTPUT_CSV), `${content}\n`);
}

function buildHtml(data, diagnostics) {
	const payloadJson = JSON.stringify(data);
	const diagnosticsJson = JSON.stringify(diagnostics);
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<title>Agent Hippo – Fleet Operations</title>
	<style>
		:root { color-scheme: dark; --bg: #0b1020; --surface: #11182b; --border: #1f2f4a; --muted: #94a3b8; --text: #e2e8f0; }
		* { box-sizing: border-box; }
		body { margin: 0; background: var(--bg); color: var(--text); font: 12px/1.5 ui-sans-serif, system-ui; }
		#fleet-summary-bar {
			position: sticky; top: 0; z-index: 10;
			display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px;
			padding: 10px 12px; background: #0f172a; border-bottom: 1px solid var(--border);
		}
		.fleet-kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
		.fleet-kpi .label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
		.fleet-kpi .value { font-size: 16px; font-weight: 700; }
		.fleet-kpi.active .value { color: #4ade80; }
		.fleet-kpi.scheduled .value { color: #60a5fa; }
		.fleet-kpi.done .value { color: var(--muted); }
		#control-bar {
			display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px;
			background: var(--surface); border-bottom: 1px solid var(--border);
		}
		#control-bar select, #control-bar input { background: #0f172a; color: var(--text); border: 1px solid #334155; border-radius: 6px; padding: 5px 8px; font-size: 12px; }
		#control-bar .control-group { display: flex; align-items: center; gap: 6px; }
		#control-bar .control-group label { color: var(--muted); font-size: 11px; }
		#control-bar .last-updated { color: var(--muted); font-size: 11px; margin-left: auto; }
		.btn-refresh { background: #1e3a5f; color: #93c5fd; border: 1px solid #3b82f6; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
		.btn-refresh:hover { background: #2563eb; color: #fff; }
		.btn-refresh.icon-only { width: 30px; min-width: 30px; padding: 5px 0; text-align: center; font-weight: 700; }
		.btn-refresh:disabled, .btn-refresh[aria-disabled="true"] { opacity: .75; cursor: wait; pointer-events: none; }
		.btn-refresh .refresh-icon {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 1em;
			height: 1em;
			line-height: 1;
			transform-origin: 50% 50%;
		}
		.btn-refresh.is-loading .refresh-icon { animation: refresh-spin 0.8s linear infinite; }
		@keyframes refresh-spin { to { transform: rotate(360deg); } }
		#fleet-canvas { display: flex; flex-direction: column; gap: 16px; padding: 12px; min-height: 200px; }
		.swimlane { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
		.swimlane.hidden-by-filter { display: none; }
		.swimlane-header { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 4px 0; user-select: none; }
		.swimlane-header:hover { opacity: .9; }
		.row-toggle { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--muted); flex-shrink: 0; }
		.swimlane.collapsed .row-toggle::before { content: '▶'; }
		.swimlane:not(.collapsed) .row-toggle::before { content: '▼'; }
		.swimlane-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0; }
		.swimlane.active .swimlane-title { color: #4ade80; }
		.swimlane.scheduled .swimlane-title { color: #60a5fa; }
		.swimlane.done .swimlane-title { color: var(--muted); }
		.swimlane-cards { display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px; }
		.swimlane.collapsed .swimlane-cards { display: none; }
		.agent-card {
			background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px;
			cursor: pointer; transition: border-color .15s, box-shadow .15s;
			min-width: 260px; max-width: 320px; flex: 1 1 260px;
		}
		.agent-card:hover { border-color: #334155; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
		.agent-card .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
		.agent-card .card-header-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
		.status-badge { font-size: 10px; border-radius: 999px; padding: 2px 8px; font-weight: 600; flex-shrink: 0; }
		.status-badge.in_progress { background: rgba(74, 222, 128, .2); color: #4ade80; border: 1px solid #22c55e; }
		.status-badge.in_progress.pulse { animation: pulse 1.5s ease-in-out infinite; }
		.status-badge.scheduled { background: rgba(96, 165, 250, .2); color: #60a5fa; border: 1px solid #3b82f6; }
		.status-badge.done { background: rgba(148, 163, 184, .15); color: var(--muted); border: 1px solid #475569; }
		@keyframes pulse { 50% { opacity: .85; } }
		.task-title { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.task-title[data-edit-title] { cursor: text; }
		.title-editor {
			font: inherit;
			font-weight: 700;
			font-size: 13px;
			width: 100%;
			min-width: 120px;
			max-width: 220px;
			background: #0f172a;
			color: var(--text);
			border: 1px solid #334155;
			border-radius: 6px;
			padding: 2px 6px;
			outline: none;
		}
		.title-editor:focus { border-color: var(--muted); }
		.connection-icon { width: 24px; height: 24px; flex-shrink: 0; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 12px; background: #1e293b; color: var(--muted); }
		.connection-icon.whatsapp { background: rgba(37, 211, 102, .2); color: #25d366; }
		.connection-icon.telegram { background: rgba(0, 136, 204, .2); color: #0088cc; }
		.agent-card .card-body { margin-bottom: 8px; }
		.start-time { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
		.telemetry-pills { display: flex; gap: 6px; flex-wrap: wrap; }
		.pill { font-size: 10px; border-radius: 999px; padding: 2px 8px; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
		.pill.alert { background: rgba(239, 68, 68, .15); color: #f87171; border-color: #dc2626; }
		.agent-card .card-footer { border-top: 1px solid var(--border); padding-top: 8px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; }
		.stack-tags { font-size: 10px; color: var(--muted); }
		.stack-tags span { margin-right: 8px; }
		.action-area { flex-shrink: 0; }
		.btn-disconnect { background: transparent; color: var(--muted); border: none; padding: 4px 6px; cursor: pointer; font-size: 11px; text-decoration: underline; }
		.btn-disconnect:hover { color: #f87171; }
		.btn-disconnect:disabled { opacity: .5; cursor: not-allowed; }
		.empty-lane { color: var(--muted); font-size: 12px; padding: 16px; border: 1px dashed var(--border); border-radius: 8px; text-align: center; }
		#msg { margin: 0 12px 12px; color: #93c5fd; min-height: 14px; font-size: 11px; }
	</style>
</head>
<body>
	<div id="fleet-summary-bar">
		<div class="fleet-kpi active"><div class="label">Active Agents</div><div class="value" id="kpi-active">0</div></div>
		<div class="fleet-kpi scheduled"><div class="label">Scheduled</div><div class="value" id="kpi-scheduled">0</div></div>
		<div class="fleet-kpi done"><div class="label">Done (24h)</div><div class="value" id="kpi-done">0</div></div>
		<div class="fleet-kpi"><div class="label">Total Tokens</div><div class="value" id="kpi-tokens">0</div></div>
		<div class="fleet-kpi"><div class="label">Total Turns</div><div class="value" id="kpi-turns">0</div></div>
	</div>
	<div id="control-bar">
		<div class="control-group">
			<label for="status-filter">Status</label>
			<select id="status-filter">
				<option value="">All</option>
				<option value="in_progress">In Progress</option>
				<option value="scheduled">Scheduled</option>
				<option value="done">Done</option>
			</select>
		</div>
		<div class="control-group">
			<label for="channel-filter">Channel</label>
			<select id="channel-filter"><option value="">All</option></select>
		</div>
		<div class="control-group">
			<label for="model-filter">Model</label>
			<select id="model-filter"><option value="">All</option></select>
		</div>
		<div class="control-group">
			<label for="sort-toggle">Sort</label>
			<select id="sort-toggle">
				<option value="status">Status then time</option>
				<option value="time">Time only</option>
			</select>
		</div>
		<button type="button" class="btn-refresh icon-only" id="manual-refresh" title="Refresh fleet widget" aria-label="Refresh fleet widget"><span class="refresh-icon">&#8635;</span></button>
		<span class="last-updated" id="last-updated"></span>
	</div>
	<div id="fleet-canvas">
		<div class="swimlane active" data-lane="in_progress">
			<div class="swimlane-header"><span class="row-toggle" aria-hidden="true"></span><span class="swimlane-title">In Progress</span></div>
			<div class="swimlane-cards" id="lane-in_progress"></div>
		</div>
		<div class="swimlane scheduled" data-lane="scheduled">
			<div class="swimlane-header"><span class="row-toggle" aria-hidden="true"></span><span class="swimlane-title">Scheduled</span></div>
			<div class="swimlane-cards" id="lane-scheduled"></div>
		</div>
		<div class="swimlane done" data-lane="done">
			<div class="swimlane-header"><span class="row-toggle" aria-hidden="true"></span><span class="swimlane-title">Done (Last 24h)</span></div>
			<div class="swimlane-cards" id="lane-done"></div>
		</div>
	</div>
	<div id="msg"></div>
	<script>
		const payload = ${payloadJson};
		const diagnostics = ${diagnosticsJson};
		const esc = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
		const statusRank = (s) => s === 'in_progress' ? 0 : s === 'scheduled' ? 1 : s === 'done' ? 2 : 3;
		let sessions = Array.isArray(payload.sessions) ? payload.sessions.slice() : [];
		const sortBy = () => document.getElementById('sort-toggle')?.value || 'status';
		function sortSessions(list) {
			const order = sortBy();
			return list.slice().sort((a, b) => {
				const aT = Date.parse(String(a.startedAt || ''));
				const bT = Date.parse(String(b.startedAt || ''));
				if (order === 'time') {
					// Newest first (matches server export ordering).
					if (Number.isFinite(aT) && Number.isFinite(bT) && aT !== bT) {
						return bT - aT;
					}
					return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
				}
				const rank = statusRank(String(a.status || '')) - statusRank(String(b.status || ''));
				if (rank !== 0) return rank;
				// Within each status lane, newest started first.
				if (Number.isFinite(aT) && Number.isFinite(bT) && aT !== bT) {
					return bT - aT;
				}
				return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
			});
		}

		const totals = payload.totals || {};
		document.getElementById('kpi-active').textContent = Number(totals.activeAgents ?? totals.inProgress ?? 0).toLocaleString();
		document.getElementById('kpi-scheduled').textContent = Number(totals.scheduled ?? 0).toLocaleString();
		document.getElementById('kpi-done').textContent = Number(totals.done ?? 0).toLocaleString();
		document.getElementById('kpi-tokens').textContent = Number(totals.tokens ?? 0).toLocaleString();
		document.getElementById('kpi-turns').textContent = Number(totals.turns ?? 0).toLocaleString();

		if (payload.generatedAt) {
			const t = new Date(payload.generatedAt).getTime();
			function updateLastUpdated() {
				const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
				const el = document.getElementById('last-updated');
				el.textContent = sec < 60 ? 'Last updated: just now' : sec < 3600 ? 'Last updated: ' + Math.floor(sec/60) + 'm ago' : 'Last updated: ' + Math.floor(sec/3600) + 'h ago';
			}
			updateLastUpdated();
			setInterval(updateLastUpdated, 60000);
		} else {
			document.getElementById('last-updated').textContent = '';
		}

		const channels = [...new Set(sessions.map(s => String(s.channelType || 'none').toLowerCase()).filter(Boolean))].sort();
		const models = [...new Set(sessions.map(s => String(s.model || '')).filter(Boolean))].sort();
		const channelSelect = document.getElementById('channel-filter');
		channels.forEach(ch => {
			const opt = document.createElement('option');
			opt.value = ch;
			opt.textContent = ch === 'none' ? 'None' : ch.charAt(0).toUpperCase() + ch.slice(1);
			channelSelect.appendChild(opt);
		});
		const modelSelect = document.getElementById('model-filter');
		models.forEach(m => {
			const opt = document.createElement('option');
			opt.value = m;
			opt.textContent = esc(m);
			modelSelect.appendChild(opt);
		});

		function formatStartTime(session) {
			const status = String(session.status || '');
			const started = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
			const ended = session.endedAt ? new Date(session.endedAt).getTime() : NaN;
			const now = Date.now();
			if (status === 'scheduled' && Number.isFinite(started) && started > now) {
				const d = new Date(started);
				const today = new Date();
				if (d.toDateString() === today.toDateString()) return 'Scheduled: Today, ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
				return 'Scheduled: ' + d.toLocaleDateString() + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
			}
			if (status === 'in_progress' && Number.isFinite(started)) {
				const min = Math.max(0, Math.floor((now - started) / 60000));
				if (min < 1) return 'Running for &lt;1m';
				return 'Running for ' + min + 'm';
			}
			if (status === 'done' && Number.isFinite(ended)) {
				const min = Math.floor((now - ended) / 60000);
				if (min < 1) return 'Ended just now';
				if (min < 60) return 'Ended ' + min + 'm ago';
				return 'Ended ' + Math.floor(min/60) + 'h ago';
			}
			return session.startedAt ? new Date(session.startedAt).toLocaleString() : '—';
		}

		function connectionIcon(channelType) {
			const ch = String(channelType || 'none').toLowerCase();
			if (ch === 'whatsapp') return '<span class="connection-icon whatsapp" title="WhatsApp">WA</span>';
			if (ch === 'telegram') return '<span class="connection-icon telegram" title="Telegram">TG</span>';
			if (ch !== 'none') return '<span class="connection-icon" title="' + esc(ch) + '">Web</span>';
			return '';
		}

		function filteredSessions() {
			const status = String(document.getElementById('status-filter').value || '').trim();
			const channel = String(document.getElementById('channel-filter').value || '').trim();
			const model = String(document.getElementById('model-filter').value || '').trim();
			const query = String(document.getElementById('search')?.value || '').trim().toLowerCase();
			return sessions.filter((session) => {
				if (status && String(session.status || '') !== status) return false;
				if (channel && String(session.channelType || 'none').toLowerCase() !== channel) return false;
				if (model && String(session.model || '') !== model) return false;
				if (!query) return true;
				const haystack = [session.sessionId, session.agentId, session.taskTitle, session.taskSummary, session.model].map(i => String(i || '').toLowerCase()).join(' ');
				return haystack.includes(query);
			});
		}

		function postRefresh() {
			const refreshBtn = document.getElementById('manual-refresh');
			if (refreshBtn && refreshBtn.classList.contains('is-loading')) {
				return;
			}
			if (refreshBtn) {
				refreshBtn.classList.add('is-loading');
				refreshBtn.setAttribute('aria-busy', 'true');
				refreshBtn.setAttribute('aria-disabled', 'true');
			}
			window.parent.postMessage({ source: 'agentide-wow-widget', type: 'refreshWidget', script: 'agent-fleet-widget.js' }, '*');
			// Fallback: if host refresh fails/no rerender, clear spinner so button is usable.
			setTimeout(() => {
				if (!refreshBtn) return;
				refreshBtn.classList.remove('is-loading');
				refreshBtn.removeAttribute('aria-busy');
				refreshBtn.removeAttribute('aria-disabled');
			}, 8000);
		}
		function postOpenSpotlight(session) {
			const msg = { source: 'agentide-wow-widget', type: 'openSpotlightForSession', sessionId: String(session.sessionId || ''), channelType: String(session.channelType || ''), channelTarget: String(session.channelTarget || '') };
			try { window.parent.postMessage(msg, '*'); } catch (e) {}
			if (window.top !== window.parent) { try { window.top.postMessage(msg, '*'); } catch (e) {} }
		}
		function postDisconnect(session, e) {
			e.preventDefault(); e.stopPropagation();
			window.parent.postMessage({ source: 'agentide-wow-widget', type: 'disconnectFleetChannel', sessionId: String(session.sessionId || ''), channelType: String(session.channelType || ''), channelTarget: String(session.channelTarget || '') }, '*');
			document.getElementById('msg').textContent = 'Disconnect requested for ' + esc(session.sessionId || 'session');
		}

		function postToHost(payload) {
			try {
				// Prefer direct webview messaging to the extension host. This bypasses
				// any seeded/older panel.js bridge code and makes title persistence
				// independent from how the outer webview forwards messages.
				const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
				if (api && typeof api.postMessage === 'function') {
					api.postMessage(payload);
					return;
				}
			} catch (err) {
				// Fall back to window.parent postMessage below.
			}
			try { window.parent.postMessage(payload, '*'); } catch (err) {}
			if (window.top !== window.parent) { try { window.top.postMessage(payload, '*'); } catch (err) {} }
		}

		function renderCard(session) {
			const status = String(session.status || 'done');
			const cardTitleRaw = session.cardTitle || session.taskTitle || session.agentId || session.sessionId || 'Task';
			const cardTitle = esc(cardTitleRaw);
			const canDisconnect = String(session.channelType || 'none').toLowerCase() !== 'none';
			const startTimeHtml = formatStartTime(session);
			const tokens = Number(session.totalTokens || 0);
			const turns = Number(session.turns || 0);
			const tokenClass = tokens > 500000 ? 'pill alert' : 'pill';
			const turnClass = turns > 100 ? 'pill alert' : 'pill';
			const model = esc(session.model || '—');
			const pack = esc(session.agentPack || '—');
			const engine = esc(session.engine || '—');
			return '<div class="agent-card" data-session-id="' + esc(session.sessionId || '') + '" data-source-id="' + esc(session.source || '') + '" role="button" tabindex="0">' +
				'<div class="card-header">' +
					'<div class="card-header-left">' +
						'<span class="status-badge ' + esc(status) + (status === 'in_progress' ? ' pulse' : '') + '">' + (status === 'in_progress' ? 'In Progress' : status === 'scheduled' ? 'Scheduled' : 'Done') + '</span>' +
						'<span class="task-title" data-edit-title title="Click to edit title">' + cardTitle + '</span>' +
						'<input class="title-editor" data-title-editor style="display:none" />' +
					'</div>' +
					connectionIcon(session.channelType) +
				'</div>' +
				'<div class="card-body">' +
					'<div class="start-time">' + startTimeHtml + '</div>' +
					'<div class="telemetry-pills">' +
						'<span class="' + tokenClass + '">' + tokens.toLocaleString() + ' Tokens</span>' +
						'<span class="' + turnClass + '">' + turns.toLocaleString() + ' Turns</span>' +
					'</div>' +
				'</div>' +
				'<div class="card-footer">' +
					'<div class="stack-tags"><span>Model: ' + model + '</span><span>Pack: ' + pack + '</span><span>Engine: ' + engine + '</span></div>' +
					'<div class="action-area">' +
						'<button type="button" class="btn-disconnect" ' + (canDisconnect ? '' : 'disabled') + ' data-disconnect>Disconnect Channel</button>' +
					'</div>' +
				'</div>' +
			'</div>';
		}

		const laneCollapsed = { in_progress: false, scheduled: false, done: false };

		function applyRowVisibility() {
			const statusFilter = String(document.getElementById('status-filter').value || '').trim();
			['in_progress', 'scheduled', 'done'].forEach(lane => {
				const row = document.querySelector('.swimlane[data-lane="' + lane + '"]');
				if (!row) return;
				const container = document.getElementById('lane-' + lane);
				const isEmpty = container && container.classList.contains('lane-empty');
				row.classList.toggle('empty', !!isEmpty);
				if (statusFilter && statusFilter !== lane) {
					row.classList.add('hidden-by-filter');
					return;
				}
				row.classList.remove('hidden-by-filter');
				if (isEmpty) {
					laneCollapsed[lane] = true;
					row.classList.add('collapsed');
				} else {
					row.classList.toggle('collapsed', !!laneCollapsed[lane]);
				}
			});
		}

		function renderLanes() {
			const items = sortSessions(filteredSessions());
			const byStatus = { in_progress: [], scheduled: [], done: [] };
			items.forEach(s => {
				const st = String(s.status || 'done');
				if (byStatus[st]) byStatus[st].push(s);
			});
			['in_progress', 'scheduled', 'done'].forEach(lane => {
				const container = document.getElementById('lane-' + lane);
				const list = byStatus[lane] || [];
				if (!list.length) {
					container.innerHTML = '<div class="empty-lane">No agents</div>';
					container.classList.add('lane-empty');
				} else {
					container.classList.remove('lane-empty');
					container.innerHTML = list.map(renderCard).join('');
					container.querySelectorAll('.agent-card').forEach((card) => {
						const sessionId = card.getAttribute('data-session-id');
						const session = list.find(s => String(s.sessionId || '') === sessionId);
						if (!session) return;
						card.addEventListener('click', (e) => {
							if (e.target.closest('[data-disconnect]')) return;
							if (e.target.closest('[data-edit-title]') || e.target.closest('[data-title-editor]')) return;
							postOpenSpotlight(session);
						});
						card.addEventListener('keydown', (e) => {
							if (e.key !== 'Enter' && e.key !== ' ') return;
							if (e.target.closest('[data-disconnect]')) return;
							if (e.target.closest('[data-edit-title]') || e.target.closest('[data-title-editor]')) return;
							e.preventDefault();
							postOpenSpotlight(session);
						});
					});
					container.querySelectorAll('.btn-disconnect').forEach((btn) => {
						const card = btn.closest('.agent-card');
						const sessionId = card && card.getAttribute('data-session-id');
						const session = list.find(s => String(s.sessionId || '') === sessionId);
						if (session) btn.addEventListener('click', (e) => postDisconnect(session, e));
					});
				}
			});
			applyRowVisibility();
		}

		document.getElementById('fleet-canvas').addEventListener('click', (e) => {
			const header = e.target.closest('.swimlane-header');
			if (!header) return;
			const row = header.closest('.swimlane');
			if (!row) return;
			const lane = row.getAttribute('data-lane');
			if (lane) {
				laneCollapsed[lane] = !laneCollapsed[lane];
				row.classList.toggle('collapsed', laneCollapsed[lane]);
			}
		});

		// Title editing: inline input -> persist via host (writes to fleet_sessions.card_title).
		document.getElementById('fleet-canvas').addEventListener('click', (e) => {
			const titleEl = e.target.closest('[data-edit-title]');
			if (!titleEl) return;
			const card = titleEl.closest('.agent-card');
			if (!card) return;
			e.preventDefault();
			e.stopPropagation();
			const sessionId = String(card.getAttribute('data-session-id') || '').trim();
			const sourceId = String(card.getAttribute('data-source-id') || '').trim() || 'local';
			if (!sessionId) return;

			const input = card.querySelector('[data-title-editor]');
			if (!(input instanceof HTMLInputElement)) return;
			const existingSession = sessions.find((s) => String(s.sessionId || '') === sessionId);
			const current = String((existingSession && (existingSession.cardTitle || existingSession.taskTitle)) || titleEl.textContent || '').trim();

			function cleanup() {
				input.style.display = 'none';
				titleEl.style.display = '';
				input.onblur = null;
				input.onkeydown = null;
			}

			function commit(nextValue) {
				const trimmed = String(nextValue || '').trim();
				postToHost({ source: 'agentide-wow-widget', type: 'updateFleetCardTitle', sourceId, sessionId, cardTitle: trimmed });
				// Keep local in-memory sessions in sync so any client-side rerender
				// (filters/sorting/host-driven rerenders) doesn't temporarily revert.
				if (existingSession) {
					existingSession.cardTitle = trimmed;
				}
				titleEl.textContent = esc(trimmed || (existingSession && existingSession.taskTitle) || sessionId);
				cleanup();
			}

			titleEl.style.display = 'none';
			input.value = current;
			input.style.display = '';
			input.focus();
			input.select();

			input.onblur = () => commit(input.value);
			input.onkeydown = (evt) => {
				if (evt.key === 'Enter') {
					evt.preventDefault();
					commit(input.value);
				} else if (evt.key === 'Escape') {
					evt.preventDefault();
					cleanup();
				}
			};
		});

		document.getElementById('manual-refresh').addEventListener('click', postRefresh);
		document.getElementById('sort-toggle').addEventListener('change', renderLanes);
		document.getElementById('status-filter').addEventListener('change', renderLanes);
		document.getElementById('channel-filter').addEventListener('change', renderLanes);
		document.getElementById('model-filter').addEventListener('change', renderLanes);

		renderLanes();

		if (!diagnostics.ok) {
			document.getElementById('msg').textContent = 'Fleet export read issue: ' + esc(diagnostics.error);
		}
	</script>
</body>
</html>`;
}

function main() {
	const home = process.env.HOME || '';
	const chartDir = process.env.AGENTIDE_CHART_DIR || path.join(home, '.agent-hippo', 'analytics', 'views', 'global', '__all', '__all', 'charts');
	const exportDir = process.env.AGENTIDE_EXPORT_DIR || path.join(home, '.agent-hippo', 'analytics', 'views', 'global', '__all', '__all', 'exports');

	fs.mkdirSync(chartDir, { recursive: true });
	fs.mkdirSync(exportDir, { recursive: true });

	const fleet = readFleetExport(exportDir);
	const sessions = Array.isArray(fleet.payload.sessions) ? fleet.payload.sessions : [];
	sessions.sort((a, b) => {
		const rank = statusRank(String(a.status || '')) - statusRank(String(b.status || ''));
		if (rank !== 0) return rank;
		// Ascending so the next/oldest scheduled items appear first.
		return Date.parse(String(a.startedAt || '')) - Date.parse(String(b.startedAt || ''));
	});

	writeCsv(exportDir, sessions);
	const html = buildHtml(
		{
			generatedAt: fleet.payload.generatedAt,
			totals: fleet.payload.totals,
			sessions,
		},
		{
			ok: fleet.ok,
			error: fleet.error || '',
			exportPath: fleet.exportPath,
		}
	);
	fs.writeFileSync(path.join(chartDir, OUTPUT_HTML), html, 'utf8');
}

main();
