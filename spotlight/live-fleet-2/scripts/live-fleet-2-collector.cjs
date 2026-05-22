#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* Tier-1 Live Fleet collector: session JSONL + workspace context dirs + CLI process hints. */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const BRAND_DIR = '.agent-hippo';
const SOURCE_ID = 'live-fleet-2';
const SNAPSHOT_FILE = 'live-fleet-2.json';
const KNOWN_WORKSPACES_FILE = 'known-workspaces.json';

const RECENT_END_IN_PROGRESS_MS = 90_000;
const RECENT_FILE_ACTIVITY_MS = 120_000;
const TASK_TITLE_MAX = 80;
const MAX_SESSIONS_IN_SNAPSHOT = 200;

function safeNumber(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : 0;
}

function getAgentHome() {
	const fromEnv = (process.env.AGENTHIPPO_HOME || process.env.AGENT_HOME || '').trim();
	if (fromEnv) {
		return path.resolve(fromEnv);
	}
	return path.join(os.homedir(), BRAND_DIR);
}

function readJsonFile(filePath, fallback) {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch {
		return fallback;
	}
}

function writeJsonAtomic(filePath, payload) {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, filePath);
}

function parsePathsMdWorkspace(pathsMdPath) {
	try {
		const text = fs.readFileSync(pathsMdPath, 'utf8');
		const match = text.match(/\*\*Workspace:\*\*\s*`([^`]+)`/);
		return match ? match[1].trim() : '';
	} catch {
		return '';
	}
}

function resolveWorkspaces(options = {}) {
	const seen = new Set();
	const roots = [];

	const add = (value) => {
		const trimmed = String(value || '').trim();
		if (!trimmed) {
			return;
		}
		const resolved = path.resolve(trimmed);
		if (seen.has(resolved)) {
			return;
		}
		seen.add(resolved);
		roots.push(resolved);
	};

	const envList = (process.env.LIVE_FLEET_WORKSPACES || '').split(',');
	for (const entry of envList) {
		add(entry);
	}

	add(options.workspaceRoot);
	add(process.env.AGENTIDE_WORKSPACE_ROOT);

	const exportDir = options.exportDir || '';
	if (exportDir) {
		const knownPath = path.join(exportDir, KNOWN_WORKSPACES_FILE);
		const known = readJsonFile(knownPath, { workspaces: [] });
		if (Array.isArray(known.workspaces)) {
			for (const ws of known.workspaces) {
				add(ws);
			}
		}
	}

	const agentHome = getAgentHome();
	add(parsePathsMdWorkspace(path.join(agentHome, 'paths.md')));

	const cwd = process.cwd();
	add(parsePathsMdWorkspace(path.join(cwd, BRAND_DIR, 'paths.md')));
	add(cwd);

	return roots.filter((root) => {
		try {
			return fs.statSync(root).isDirectory();
		} catch {
			return false;
		}
	});
}

function persistKnownWorkspaces(exportDir, workspaces) {
	if (!exportDir) {
		return;
	}
	const knownPath = path.join(exportDir, KNOWN_WORKSPACES_FILE);
	const existing = readJsonFile(knownPath, { workspaces: [] });
	const merged = new Set([
		...(Array.isArray(existing.workspaces) ? existing.workspaces : []),
		...workspaces,
	]);
	writeJsonAtomic(knownPath, {
		updatedAt: new Date().toISOString(),
		workspaces: Array.from(merged).sort(),
	});
}

function truncateTitle(text) {
	const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
	if (!trimmed) {
		return '';
	}
	if (trimmed.length <= TASK_TITLE_MAX) {
		return trimmed;
	}
	return `${trimmed.slice(0, TASK_TITLE_MAX - 3)}...`;
}

function extractUserBlocks(contextText) {
	const blocks = [];
	const re = /\*\*User:\*\*\s*\n([\s\S]*?)(?=\n\*\*(?:Assistant|User):|$)/gi;
	let match = re.exec(contextText);
	while (match) {
		blocks.push(match[1].trim());
		match = re.exec(contextText);
	}
	return blocks;
}

function taskTitleFromContext(contextText) {
	const blocks = extractUserBlocks(contextText);
	if (!blocks.length) {
		return '';
	}
	return truncateTitle(blocks[blocks.length - 1] || blocks[0]);
}

function readTailLines(filePath, maxLines = 400) {
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const lines = raw.split('\n').filter((line) => line.trim());
		return lines.slice(-maxLines);
	} catch {
		return [];
	}
}

function parseSessionJsonl(filePath) {
	const lines = readTailLines(filePath);
	const events = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === 'object' && parsed.event_type) {
				events.push(parsed);
			}
		} catch {
			// skip malformed lines
		}
	}

	const byRequest = new Map();
	let firstStartMs = Number.POSITIVE_INFINITY;
	let lastEventMs = 0;
	let turnCount = 0;

	for (const event of events) {
		const ts = safeNumber(event.timestamp);
		if (ts > 0) {
			lastEventMs = Math.max(lastEventMs, ts);
		}
		const requestId = String(event.request_id || 'default');
		if (!byRequest.has(requestId)) {
			byRequest.set(requestId, { lastStart: 0, lastEnd: 0 });
		}
		const bucket = byRequest.get(requestId);
		if (event.event_type === 'turn_start') {
			bucket.lastStart = Math.max(bucket.lastStart, ts || Date.now());
			firstStartMs = Math.min(firstStartMs, ts || Date.now());
		} else if (event.event_type === 'turn_end') {
			bucket.lastEnd = Math.max(bucket.lastEnd, ts || Date.now());
			turnCount += 1;
		}
	}

	let openTurn = false;
	for (const bucket of byRequest.values()) {
		if (bucket.lastStart > bucket.lastEnd) {
			openTurn = true;
		}
	}

	let fileMtimeMs = 0;
	try {
		fileMtimeMs = fs.statSync(filePath).mtimeMs;
	} catch {
		fileMtimeMs = 0;
	}

	const now = Date.now();
	let status = 'done';
	if (openTurn) {
		status = 'in_progress';
	} else if (lastEventMs > now - RECENT_END_IN_PROGRESS_MS) {
		status = 'in_progress';
	} else if (fileMtimeMs > now - RECENT_FILE_ACTIVITY_MS) {
		status = 'in_progress';
	}

	const startedAt = Number.isFinite(firstStartMs) && firstStartMs < Number.POSITIVE_INFINITY
		? new Date(firstStartMs).toISOString()
		: new Date(fileMtimeMs || now).toISOString();
	const endedAt = status === 'in_progress' ? '' : new Date(Math.max(lastEventMs, fileMtimeMs)).toISOString();

	return {
		status,
		startedAt,
		endedAt,
		turns: turnCount,
		lastActivityMs: Math.max(lastEventMs, fileMtimeMs),
		openTurn,
	};
}

function scanAnalyticsSessions(agentHome) {
	const sessionsDir = path.join(agentHome, 'analytics', 'sessions');
	const rows = new Map();
	try {
		const files = fs.readdirSync(sessionsDir);
		for (const file of files) {
			if (!file.endsWith('.jsonl')) {
				continue;
			}
			const sessionId = file.slice(0, -'.jsonl'.length);
			const filePath = path.join(sessionsDir, file);
			const parsed = parseSessionJsonl(filePath);
			rows.set(sessionId, {
				sessionId,
				...parsed,
				engine: inferEngineFromSessionId(sessionId),
				model: 'unknown',
				agentId: '',
				taskTitle: '',
				channelType: 'none',
				channelTarget: '',
				totalTokens: 0,
				disconnectCapable: false,
				workspaceRoot: '',
			});
		}
	} catch {
		// no analytics sessions dir yet
	}
	return rows;
}

function inferEngineFromSessionId(sessionId) {
	const id = String(sessionId || '');
	if (id.startsWith('cli-')) {
		return 'cli';
	}
	if (id.startsWith('headless-')) {
		return 'headless';
	}
	return '';
}

function scanWorkspaceSessions(workspaceRoot) {
	const sessionsDir = path.join(workspaceRoot, BRAND_DIR, 'sessions');
	const rows = [];
	try {
		const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const sessionId = entry.name;
			const sessionDir = path.join(sessionsDir, sessionId);
			const contextPath = path.join(sessionDir, 'context.md');
			const terminalPath = path.join(sessionDir, 'terminal.md');

			let contextMtime = 0;
			let terminalMtime = 0;
			let taskTitle = '';
			try {
				const contextStat = fs.statSync(contextPath);
				contextMtime = contextStat.mtimeMs;
				taskTitle = taskTitleFromContext(fs.readFileSync(contextPath, 'utf8'));
			} catch {
				// no context yet
			}
			try {
				terminalMtime = fs.statSync(terminalPath).mtimeMs;
			} catch {
				// no terminal log
			}

			const dirMtime = fs.statSync(sessionDir).mtimeMs;
			const lastActivityMs = Math.max(contextMtime, terminalMtime, dirMtime);
			const now = Date.now();
			const status = lastActivityMs > now - RECENT_FILE_ACTIVITY_MS ? 'in_progress' : 'done';

			rows.push({
				sessionId,
				status,
				startedAt: new Date(dirMtime || now).toISOString(),
				endedAt: status === 'in_progress' ? '' : new Date(lastActivityMs || dirMtime).toISOString(),
				turns: 0,
				lastActivityMs,
				openTurn: status === 'in_progress',
				engine: '',
				model: 'unknown',
				agentId: '',
				taskTitle,
				channelType: 'none',
				channelTarget: '',
				totalTokens: 0,
				disconnectCapable: false,
				workspaceRoot,
			});
		}
	} catch {
		// no workspace sessions dir
	}
	return rows;
}

function detectCliActivity() {
	const hints = {
		anyCli: false,
		anyServe: false,
		engines: new Set(),
	};
	try {
		const cmd = process.platform === 'win32' ? 'wmic process get commandline' : 'ps -ax -o command=';
		const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
		for (const line of out.split('\n')) {
			const text = line.trim();
			if (!text) {
				continue;
			}
			if (/\bagenthippo\b/i.test(text) && /\b(chat|ask)\b/i.test(text)) {
				hints.anyCli = true;
				const engineMatch = text.match(/--engine\s+([^\s]+)/i);
				if (engineMatch) {
					hints.engines.add(engineMatch[1].toLowerCase());
				}
			}
			if (/\bagenthippo\b/i.test(text) && /\bserve\b/i.test(text)) {
				hints.anyServe = true;
			}
			if (/custom-engine[-\w]*-runner\.mjs/i.test(text)) {
				hints.anyCli = true;
				hints.engines.add('custom');
			}
		}
	} catch {
		// ps unavailable
	}
	return hints;
}

function mergeSessionMaps(jsonlRows, workspaceRows, cliHints) {
	const merged = new Map();

	const upsert = (row) => {
		const sessionId = String(row.sessionId || '').trim();
		if (!sessionId) {
			return;
		}
		const existing = merged.get(sessionId);
		if (!existing) {
			merged.set(sessionId, { ...row });
			return;
		}

		const statusRank = { in_progress: 0, scheduled: 1, done: 2 };
		const pickStatus =
			(statusRank[row.status] ?? 3) < (statusRank[existing.status] ?? 3) ? row.status : existing.status;

		merged.set(sessionId, {
			...existing,
			...row,
			status: pickStatus,
			taskTitle: row.taskTitle || existing.taskTitle,
			engine: row.engine || existing.engine,
			turns: Math.max(safeNumber(row.turns), safeNumber(existing.turns)),
			lastActivityMs: Math.max(safeNumber(row.lastActivityMs), safeNumber(existing.lastActivityMs)),
			workspaceRoot: row.workspaceRoot || existing.workspaceRoot,
			openTurn: Boolean(row.openTurn || existing.openTurn),
		});
	};

	for (const row of jsonlRows.values()) {
		upsert(row);
	}
	for (const row of workspaceRows) {
		upsert(row);
	}

	if (cliHints.anyCli || cliHints.anyServe) {
		const now = Date.now();
		for (const row of merged.values()) {
			const id = String(row.sessionId || '');
			const isCliLike = id.startsWith('cli-') || id.startsWith('headless-');
			if (!isCliLike && !row.openTurn) {
				continue;
			}
			if (row.lastActivityMs > now - RECENT_FILE_ACTIVITY_MS || row.openTurn) {
				row.status = 'in_progress';
				row.endedAt = '';
				if (!row.engine && cliHints.engines.size === 1) {
					row.engine = Array.from(cliHints.engines)[0];
				} else if (!row.engine && cliHints.anyCli) {
					row.engine = 'cli';
				} else if (!row.engine && cliHints.anyServe) {
					row.engine = 'serve';
				}
			}
		}
	}

	return merged;
}

function buildTotals(sessions) {
	const totals = {
		sessions: sessions.length,
		activeAgents: 0,
		inProgress: 0,
		scheduled: 0,
		done: 0,
		tokens: 0,
		turns: 0,
	};
	const agents = new Set();
	for (const session of sessions) {
		if (session.agentId) {
			agents.add(session.agentId);
		}
		if (session.status === 'in_progress') {
			totals.inProgress += 1;
		} else if (session.status === 'scheduled') {
			totals.scheduled += 1;
		} else {
			totals.done += 1;
		}
		totals.tokens += safeNumber(session.totalTokens);
		totals.turns += safeNumber(session.turns);
	}
	totals.activeAgents = agents.size || sessions.filter((s) => s.status === 'in_progress').length;
	return totals;
}

function collect(options = {}) {
	const agentHome = getAgentHome();
	const exportDir = options.exportDir || '';
	const workspaces = resolveWorkspaces(options);
	if (exportDir) {
		persistKnownWorkspaces(exportDir, workspaces);
	}

	const jsonlRows = scanAnalyticsSessions(agentHome);
	const workspaceRows = [];
	for (const workspaceRoot of workspaces) {
		workspaceRows.push(...scanWorkspaceSessions(workspaceRoot));
	}

	const cliHints = detectCliActivity();
	const merged = mergeSessionMaps(jsonlRows, workspaceRows, cliHints);

	const sorted = Array.from(merged.values())
		.map((row) => ({
			sessionId: row.sessionId,
			agentId: row.agentId || undefined,
			agentPack: row.agentId || undefined,
			cardTitle: row.taskTitle || undefined,
			status: row.status,
			startedAt: row.startedAt,
			endedAt: row.endedAt || '',
			taskTitle: row.taskTitle || row.sessionId,
			model: row.model || 'unknown',
			engine: row.engine || '',
			channelType: row.channelType || 'none',
			channelTarget: row.channelTarget || '',
			turns: safeNumber(row.turns),
			totalTokens: safeNumber(row.totalTokens),
			disconnectCapable: Boolean(row.disconnectCapable),
			source: SOURCE_ID,
			workspaceRoot: row.workspaceRoot || undefined,
		}))
		.sort((a, b) => {
			const rank = { in_progress: 0, scheduled: 1, done: 2 };
			const rankDiff = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
			if (rankDiff !== 0) {
				return rankDiff;
			}
			return Date.parse(b.startedAt || '') - Date.parse(a.startedAt || '');
		});

	const live = sorted.filter((s) => s.status !== 'done');
	const done = sorted.filter((s) => s.status === 'done');
	const room = Math.max(0, MAX_SESSIONS_IN_SNAPSHOT - live.length);
	const sessions = [...live, ...done.slice(0, room)];

	return {
		generatedAt: new Date().toISOString(),
		scope: 'global',
		projectId: '',
		agentId: '',
		totals: buildTotals(sessions),
		sessions,
		diagnostics: {
			agentHome,
			workspaces,
			jsonlCount: jsonlRows.size,
			workspaceFolderCount: workspaceRows.length,
			cliActive: cliHints.anyCli || cliHints.anyServe,
		},
	};
}

function writeSnapshot(exportDir, payload) {
	const exportPath = path.join(exportDir, SNAPSHOT_FILE);
	writeJsonAtomic(exportPath, payload);
	return exportPath;
}

function resolveDefaultExportDir() {
	if (process.env.LIVE_FLEET_EXPORT_DIR) {
		return path.resolve(process.env.LIVE_FLEET_EXPORT_DIR);
	}
	return path.join(__dirname, '..', 'exports');
}

function runWidgetRender(exportDir) {
	const widgetPath = path.join(__dirname, 'live-fleet-2-widget.cjs');
	const result = spawnSync(process.execPath, [widgetPath], {
		env: {
			...process.env,
			LIVE_FLEET_EXPORT_DIR: exportDir,
			LIVE_FLEET_SKIP_COLLECTOR: '1',
		},
		encoding: 'utf8',
		timeout: 60_000,
	});
	if (result.status !== 0) {
		console.warn('[live-fleet-2] Widget render failed:', result.stderr || result.stdout || result.status);
		return false;
	}
	return true;
}

function main() {
	const exportDir = resolveDefaultExportDir();
	const payload = collect({ exportDir, workspaceRoot: process.env.AGENTIDE_WORKSPACE_ROOT });
	const exportPath = writeSnapshot(exportDir, payload);
	console.log(`[live-fleet-2] Wrote ${payload.sessions.length} session(s) → ${exportPath}`);
	if (process.env.LIVE_FLEET_SKIP_WIDGET !== '1') {
		runWidgetRender(exportDir);
	}
}

module.exports = {
	SNAPSHOT_FILE,
	SOURCE_ID,
	collect,
	writeSnapshot,
	resolveWorkspaces,
	getAgentHome,
};

if (require.main === module) {
	main();
}
