#!/usr/bin/env node
/* Copyright (c) AgentHippo.ai. All rights reserved. */
/* Watches session JSONL + workspace session dirs; refreshes live-fleet-2.json. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const { collect, writeSnapshot, getAgentHome } = require('./live-fleet-2-collector.cjs');

const BRAND_DIR = '.agent-hippo';
const DEBOUNCE_MS = 500;
const POLL_MS = 3000;

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
	const envList = (process.env.LIVE_FLEET_WORKSPACES || '').split(',');
	for (const entry of envList) {
		const trimmed = entry.trim();
		if (trimmed) {
			workspaces.add(path.resolve(trimmed));
		}
	}
	const fromEnv = (process.env.AGENTIDE_WORKSPACE_ROOT || '').trim();
	if (fromEnv) {
		workspaces.add(path.resolve(fromEnv));
	}

	const knownPath = path.join(exportDir, 'known-workspaces.json');
	try {
		const known = JSON.parse(fs.readFileSync(knownPath, 'utf8'));
		if (Array.isArray(known.workspaces)) {
			for (const ws of known.workspaces) {
				workspaces.add(path.resolve(ws));
			}
		}
	} catch {
		// first run
	}

	for (const workspaceRoot of workspaces) {
		roots.push(path.join(workspaceRoot, BRAND_DIR, 'sessions'));
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
	writeSnapshot(exportDir, payload);
	return payload.sessions.length;
}

function main() {
	const exportDir = resolveExportDir();
	fs.mkdirSync(exportDir, { recursive: true });

	let debounceTimer;
	let running = false;

	const run = () => {
		if (running) {
			return;
		}
		running = true;
		try {
			const count = refresh(exportDir);
			const stamp = new Date().toISOString();
			process.stdout.write(`[live-fleet-2-daemon] ${stamp} ${count} session(s)\n`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[live-fleet-2-daemon] refresh failed: ${message}\n`);
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
			process.stdout.write(`[live-fleet-2-daemon] watching ${root}\n`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[live-fleet-2-daemon] skip watch ${root}: ${message}\n`);
		}
	}

	run();
	const interval = setInterval(run, POLL_MS);

	const shutdown = () => {
		clearInterval(interval);
		clearTimeout(debounceTimer);
		for (const watcher of watchers) {
			watcher.close();
		}
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main();
