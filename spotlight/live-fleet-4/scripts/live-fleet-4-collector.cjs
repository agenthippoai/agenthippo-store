#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* Live Fleet 4 collector: fleet-workflows + history archives. */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const BRAND_DIR = '.agent-hippo';
const WORKFLOWS_DIRNAME = 'fleet-workflows';
const HISTORY_DIRNAME = 'history';
const SOURCE_ID = 'live-fleet-4';
const SNAPSHOT_FILE = 'live-fleet-4.json';
const KNOWN_WORKSPACES_FILE = 'known-workspaces.json';

function getAgentHome() {
	const fromEnv = (process.env.AGENTHIPPO_HOME || process.env.AGENT_HOME || '').trim();
	return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), BRAND_DIR);
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
		if (!trimmed) return;
		const resolved = path.resolve(trimmed);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		roots.push(resolved);
	};

	for (const entry of (process.env.LIVE_FLEET_WORKSPACES || '').split(',')) {
		add(entry);
	}
	add(options.workspaceRoot);
	add(process.env.AGENTIDE_WORKSPACE_ROOT);
	add(parsePathsMdWorkspace(path.join(getAgentHome(), 'paths.md')));
	add(parsePathsMdWorkspace(path.join(process.cwd(), BRAND_DIR, 'paths.md')));
	add(process.cwd());

	return roots.filter((root) => {
		try {
			return fs.statSync(root).isDirectory();
		} catch {
			return false;
		}
	});
}

function persistKnownWorkspaces(exportDir, workspaces) {
	if (!exportDir) return;
	const knownPath = path.join(exportDir, KNOWN_WORKSPACES_FILE);
	let existing = { workspaces: [] };
	try {
		existing = JSON.parse(fs.readFileSync(knownPath, 'utf8'));
	} catch { /* first run */ }
	const merged = new Set([
		...(Array.isArray(existing.workspaces) ? existing.workspaces : []),
		...workspaces,
	]);
	const nextWorkspaces = Array.from(merged).sort();
	const prevWorkspaces = Array.isArray(existing.workspaces) ? [...existing.workspaces].sort() : [];
	if (nextWorkspaces.length === prevWorkspaces.length
		&& nextWorkspaces.every((ws, i) => ws === prevWorkspaces[i])) {
		return;
	}
	fs.mkdirSync(exportDir, { recursive: true });
	fs.writeFileSync(knownPath, `${JSON.stringify({
		updatedAt: new Date().toISOString(),
		workspaces: nextWorkspaces,
	}, null, 2)}\n`, 'utf8');
}

function readWorkflowFile(filePath, workspaceRoot, kind) {
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const doc = JSON.parse(raw);
		if (!doc || typeof doc !== 'object') return null;
		const stat = fs.statSync(filePath);
		const base = path.basename(filePath, '.json');
		return {
			...doc,
			kind: doc.kind || kind,
			runId: doc.runId || base.split('-').slice(-1)[0],
			_file: filePath,
			_workspaceRoot: workspaceRoot,
			_mtimeMs: stat.mtimeMs,
		};
	} catch {
		return null;
	}
}

function scanDir(dir, workspaceRoot, kind) {
	const workflows = [];
	if (!dir) return workflows;
	try {
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith('.json') || file.startsWith('.')) continue;
			const filePath = path.join(dir, file);
			const doc = readWorkflowFile(filePath, workspaceRoot, kind);
			if (doc) workflows.push(doc);
		}
	} catch { /* missing */ }
	return workflows;
}

function scanWorkspace(workspaceRoot) {
	const root = path.join(workspaceRoot, BRAND_DIR, WORKFLOWS_DIRNAME);
	const active = scanDir(root, workspaceRoot, 'active');
	const history = scanDir(path.join(root, HISTORY_DIRNAME), workspaceRoot, 'history');
	return [...active, ...history];
}

function detectCliActive() {
	try {
		const cmd = process.platform === 'win32' ? 'wmic process get commandline' : 'ps -ax -o command=';
		const out = execSync(cmd, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
		return /\bagenthippo\b/i.test(out) && /\b(ask|chat)\b/i.test(out);
	} catch {
		return false;
	}
}

function normalizeWorkflow(wf) {
	return {
		workflowId: wf.workflowId,
		runId: wf.runId || '',
		title: wf.title || wf.workflowId,
		subtitle: wf.subtitle || '',
		status: wf.status || 'in_progress',
		kind: wf.kind || 'active',
		startedAt: wf.startedAt || '',
		updatedAt: wf.updatedAt || '',
		finishedAt: wf.finishedAt || '',
		archivedAt: wf.archivedAt || '',
		artifact: wf.artifact || wf._file || '',
		orchestrator: wf.orchestrator || {},
		steps: (Array.isArray(wf.steps) ? wf.steps : []).slice().sort((a, b) => (a.step || 0) - (b.step || 0)),
		workspaceRoot: wf._workspaceRoot || '',
		sourcePath: wf._file || '',
	};
}

function workflowKey(wf) {
	return `${wf.workflowId}::${wf.runId || wf.startedAt || wf.updatedAt}`;
}

function buildTotals(running, finished, history) {
	let stepsTotal = 0;
	let stepsDone = 0;
	let stepsActive = 0;
	for (const wf of [...running, ...finished, ...history]) {
		const steps = wf.steps || [];
		stepsTotal += steps.length;
		stepsDone += steps.filter((s) => s.status === 'done').length;
		stepsActive += steps.filter((s) => s.status === 'in_progress').length;
	}
	return {
		workflows: running.length + finished.length + history.length,
		running: running.length,
		finished: history.length,
		history: history.length,
		inProgress: running.length,
		done: history.length + running.filter((w) => w.status === 'done').length,
		stepsTotal,
		stepsDone,
		stepsActive,
	};
}

function collect(options = {}) {
	const exportDir = options.exportDir || '';
	const workspaces = resolveWorkspaces(options);
	if (exportDir) persistKnownWorkspaces(exportDir, workspaces);

	const all = [];
	for (const root of workspaces) {
		all.push(...scanWorkspace(root));
	}

	const byKey = new Map();
	for (const wf of all) {
		const normalized = normalizeWorkflow(wf);
		const key = workflowKey(normalized);
		const existing = byKey.get(key);
		if (!existing || (wf._mtimeMs || 0) >= (existing._mtimeMs || 0)) {
			byKey.set(key, { ...normalized, _mtimeMs: wf._mtimeMs });
		}
	}

	const workflows = Array.from(byKey.values()).map(({ _mtimeMs, ...rest }) => rest);
	const running = workflows.filter((w) => w.kind === 'active' && w.status === 'in_progress')
		.sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
	const finished = workflows.filter((w) => w.kind === 'active' && w.status === 'done')
		.sort((a, b) => Date.parse(b.finishedAt || b.updatedAt || '') - Date.parse(a.finishedAt || a.updatedAt || ''));
	const history = workflows.filter((w) => w.kind === 'history')
		.sort((a, b) => Date.parse(b.archivedAt || b.finishedAt || b.updatedAt || '') - Date.parse(a.archivedAt || a.finishedAt || a.updatedAt || ''));

	return {
		generatedAt: new Date().toISOString(),
		source: SOURCE_ID,
		totals: buildTotals(running, finished, history),
		running,
		finished,
		history,
		workflows: [...running, ...finished, ...history],
		diagnostics: {
			workspaces,
			cliActive: detectCliActive(),
			workflowCount: workflows.length,
		},
	};
}

/** Compare export bodies ignoring generatedAt and volatile CLI hints. */
function stableExportString(payload) {
	const clone = { ...payload };
	delete clone.generatedAt;
	if (clone.diagnostics && typeof clone.diagnostics === 'object') {
		const diag = { ...clone.diagnostics };
		delete diag.cliActive;
		clone.diagnostics = diag;
	}
	return JSON.stringify(clone);
}

function writeSnapshot(exportDir, payload) {
	fs.mkdirSync(exportDir, { recursive: true });
	const exportPath = path.join(exportDir, SNAPSHOT_FILE);
	let existingRaw = '';
	let existingGeneratedAt = '';
	try {
		existingRaw = fs.readFileSync(exportPath, 'utf8');
		const existing = JSON.parse(existingRaw);
		existingGeneratedAt = existing.generatedAt || '';
		if (stableExportString(existing) === stableExportString(payload)) {
			return { exportPath, changed: false };
		}
	} catch { /* first write */ }

	const toWrite = {
		...payload,
		generatedAt: new Date().toISOString(),
	};
	const body = `${JSON.stringify(toWrite, null, 2)}\n`;
	if (existingRaw === body) {
		return { exportPath, changed: false };
	}
	const tmp = `${exportPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, body, 'utf8');
	fs.renameSync(tmp, exportPath);
	return { exportPath, changed: true };
}

function main() {
	const exportDir = process.env.LIVE_FLEET_EXPORT_DIR
		? path.resolve(process.env.LIVE_FLEET_EXPORT_DIR)
		: path.join(__dirname, '..', 'exports');
	const payload = collect({ exportDir, workspaceRoot: process.env.AGENTIDE_WORKSPACE_ROOT });
	const { exportPath, changed } = writeSnapshot(exportDir, payload);
	console.log(`[live-fleet-4] ${payload.totals.running} running, ${payload.totals.finished} finished, ${payload.totals.history} history → ${exportPath}${changed ? '' : ' (unchanged)'}`);
}

module.exports = {
	SNAPSHOT_FILE,
	SOURCE_ID,
	collect,
	writeSnapshot,
	resolveWorkspaces,
	getAgentHome,
	WORKFLOWS_DIRNAME,
	HISTORY_DIRNAME,
	persistKnownWorkspaces,
};

if (require.main === module) {
	main();
}
