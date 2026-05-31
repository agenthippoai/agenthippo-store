#!/usr/bin/env node
/* Live Fleet 4 daemon — watches fleet-workflows + history; refreshes live-fleet-4.json */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
	collect,
	writeSnapshot,
	getAgentHome,
	WORKFLOWS_DIRNAME,
	HISTORY_DIRNAME,
	persistKnownWorkspaces,
} = require('./live-fleet-4-collector.cjs');

const BRAND_DIR = '.agent-hippo';
const DEBOUNCE_MS = 350;
const POLL_MS = 2500;

function resolveExportDir() {
	if (process.env.LIVE_FLEET_EXPORT_DIR) {
		return path.resolve(process.env.LIVE_FLEET_EXPORT_DIR);
	}
	return path.join(__dirname, '..', 'exports');
}

function resolveWatchRoots(exportDir) {
	const agentHome = getAgentHome();
	const roots = [
		path.join(agentHome, 'analytics', 'sessions'),
	];

	const workspaces = new Set();
	for (const entry of (process.env.LIVE_FLEET_WORKSPACES || '').split(',')) {
		const t = entry.trim();
		if (t) workspaces.add(path.resolve(t));
	}
	const fromEnv = (process.env.AGENTIDE_WORKSPACE_ROOT || '').trim();
	if (fromEnv) workspaces.add(path.resolve(fromEnv));

	try {
		const knownPath = path.join(exportDir, 'known-workspaces.json');
		const known = JSON.parse(fs.readFileSync(knownPath, 'utf8'));
		if (Array.isArray(known.workspaces)) {
			for (const ws of known.workspaces) workspaces.add(path.resolve(ws));
		}
	} catch { /* first run */ }

	for (const workspaceRoot of workspaces) {
		roots.push(path.join(workspaceRoot, BRAND_DIR, WORKFLOWS_DIRNAME));
		roots.push(path.join(workspaceRoot, BRAND_DIR, WORKFLOWS_DIRNAME, HISTORY_DIRNAME));
	}

	return roots.filter((root) => {
		try {
			fs.mkdirSync(root, { recursive: true });
			return true;
		} catch {
			return false;
		}
	});
}

function refresh(exportDir) {
	const payload = collect({
		exportDir,
		workspaceRoot: process.env.AGENTIDE_WORKSPACE_ROOT,
	});
	const { changed } = writeSnapshot(exportDir, payload);
	return { payload, changed };
}

function main() {
	const exportDir = resolveExportDir();
	fs.mkdirSync(exportDir, { recursive: true });

	let debounceTimer;
	let running = false;

	const run = () => {
		if (running) return;
		running = true;
		try {
			const { payload, changed } = refresh(exportDir);
			if (!changed) {
				running = false;
				return;
			}
			const t = payload.totals || {};
			process.stdout.write(
				`[live-fleet-4-daemon] ${new Date().toISOString()} `
				+ `run=${t.running || 0} done=${t.finished || 0} hist=${t.history || 0}`
				+ (payload.diagnostics?.cliActive ? ' cli' : '') + '\n',
			);
		} catch (err) {
			process.stderr.write(`[live-fleet-4-daemon] ${err instanceof Error ? err.message : String(err)}\n`);
		} finally {
			running = false;
		}
	};

	const schedule = () => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(run, DEBOUNCE_MS);
	};

	const watchers = [];
	for (const root of resolveWatchRoots(exportDir)) {
		try {
			const watcher = fs.watch(root, { recursive: true }, schedule);
			watchers.push(watcher);
			process.stdout.write(`[live-fleet-4-daemon] watching ${root}\n`);
		} catch (err) {
			process.stderr.write(`[live-fleet-4-daemon] skip ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	run();
	const interval = setInterval(run, POLL_MS);

	const shutdown = () => {
		clearInterval(interval);
		clearTimeout(debounceTimer);
		for (const w of watchers) w.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main();
