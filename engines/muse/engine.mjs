// @ts-check
/**
 * Meta Muse Code CLI engine bridge for AgentHippo.
 *
 * Spawns the official Muse Code CLI (install: curl -fsSL https://dev.meta.ai/install.sh | bash)
 * in headless mode: `muse exec --json` streams JSONL events on stdout.
 *
 * Docs: https://dev.meta.ai/docs/muse-code
 * Routing: Muse fetches `GET <base-url>/muse-code/models` (proprietary catalog schema) and then
 * POSTs inference to `<base-url>/responses` — the OpenAI Responses API, which LiteLLM serves. So
 * LiteLLM models (e.g. ah-auto) work through `scripts/litellm-shim.py`, which answers the catalog
 * and proxies /responses; point MUSE_BASE_URL at it and set any non-empty META_API_KEY.
 * Without the shim, inference goes direct to Meta (META_API_KEY or `muse login`).
 * Set MUSE_PROVIDER=echo for an offline dry run (no model calls).
 *
 * Session continuity: Muse sessions are event-sourced and keyed by a UUID. This bridge derives a
 * stable UUID from the AgentHippo conversation key and passes `--session-id` on every turn, so
 * turn N+1 continues the same append-only session log without replaying history.
 */

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const CLI_BIN = 'muse';
const META_API_KEY_ENV = 'META_API_KEY';
const BASE_URL_ENV = 'MUSE_BASE_URL';
const DEFAULT_MUSE_CONFIG_DIR = path.join(os.homedir(), '.config', 'muse');

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIM_SCRIPT = path.join(ENGINE_DIR, 'scripts', 'litellm-shim.py');
const SHIM_HOST = '127.0.0.1';
const SHIM_PORT = Number(process.env.MUSE_SHIM_PORT || 4399);
const SHIM_KEY = 'sk-shim';

/** @type {Record<string, string> | undefined} */
let agentHippoEnvCache;

/**
 * `setup-analytics` writes the LiteLLM credentials to ~/.agent-hippo/.env; hosts that do not
 * populate `turn.routing` still have them there.
 * @param {string} key
 */
function agentHippoEnvValue(key) {
	if (!agentHippoEnvCache) {
		agentHippoEnvCache = {};
		try {
			const raw = readFileSync(path.join(os.homedir(), '.agent-hippo', '.env'), 'utf8');
			for (const line of raw.split(/\r?\n/)) {
				const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
				if (match) {
					agentHippoEnvCache[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
				}
			}
		} catch {
			// no env file — fall through to undefined
		}
	}
	return agentHippoEnvCache[key] || undefined;
}

/**
 * @param {number} port
 * @param {number} timeoutMs
 */
function portIsOpen(port, timeoutMs = 500) {
	return new Promise(resolve => {
		const socket = net.connect({ host: SHIM_HOST, port });
		const finish = result => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => finish(true));
		socket.once('timeout', () => finish(false));
		socket.once('error', () => finish(false));
	});
}

/**
 * Host runtimes may ship a logger without `debug`; drop the line rather than crash the worker.
 * @param {import('./engine-contract.d.ts').Runtime} runtime
 * @param {string} message
 */
function logDebug(runtime, message) {
	runtime.logger?.debug?.(message);
}

function firstLine(value) {
	return String(value ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || undefined;
}

async function which(binary) {
	const command = IS_WIN ? 'where.exe' : 'which';
	try {
		const result = await execFileAsync(command, [binary], { windowsHide: true });
		return firstLine(result.stdout);
	} catch {
		return undefined;
	}
}

/**
 * @param {string | undefined} explicit
 */
function expandHome(explicit) {
	if (!explicit?.trim()) {
		return undefined;
	}
	const trimmed = explicit.trim();
	if (trimmed.startsWith('~/')) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return trimmed;
}

async function findMuseBinary() {
	const explicit = expandHome(process.env.MUSE_CLI_PATH);
	if (explicit && existsSync(explicit)) {
		return explicit;
	}

	const candidates = [
		path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'muse.exe' : 'muse'),
		path.join(os.homedir(), '.muse', 'bin', IS_WIN ? 'muse.exe' : 'muse'),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return await which(CLI_BIN);
}

/**
 * @param {string} binary
 * @param {string[]} cliArgs
 */
function commandForSpawn(binary, cliArgs) {
	if (!IS_WIN || !/\.cmd$/i.test(binary)) {
		return { command: binary, args: cliArgs };
	}
	return {
		command: process.env.ComSpec || 'cmd.exe',
		args: ['/d', '/s', '/c', binary, ...cliArgs],
	};
}

/**
 * `muse login` writes credentials to MUSE_AUTH_PATH, else $XDG_CONFIG_HOME/muse/auth.json, else
 * ~/.config/muse/auth.json (confirmed in the launcher). This is deliberately NOT the manifest's
 * MUSE_HOME dir — checking there would never find a real login.
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveMuseAuthPath(turn) {
	const explicit = turn.env.MUSE_AUTH_PATH?.trim() || process.env.MUSE_AUTH_PATH?.trim();
	if (explicit) {
		return explicit;
	}
	const xdgConfig =
		turn.env.XDG_CONFIG_HOME?.trim() ||
		process.env.XDG_CONFIG_HOME?.trim() ||
		path.join(os.homedir(), '.config');
	return path.join(xdgConfig, 'muse', 'auth.json');
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function hasMuseLoginAuth(turn) {
	return existsSync(resolveMuseAuthPath(turn));
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveApiKey(turn) {
	// AgentHippo fills the manifest's apiKeyEnvVar with whatever key its routing resolved — the
	// LiteLLM proxy key, or a fallback provider key such as OPENAI_API_KEY. Muse rejects those, so
	// any candidate that merely mirrors another provider's key is discarded.
	const borrowed = new Set(
		['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AGENTHIPPO_LITELLM_API_KEY', 'LITELLM_MASTER_KEY']
			.flatMap(name => [process.env[name], turn.env[name]])
			.concat(turn.routing.apiKey)
			.map(value => value?.trim())
			.filter(Boolean),
	);

	for (const value of [process.env[META_API_KEY_ENV], turn.env[META_API_KEY_ENV]]) {
		const key = value?.trim();
		if (key && key !== 'sk-dummy' && !borrowed.has(key)) {
			return key;
		}
	}
	return undefined;
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveMuseConfigDir(turn) {
	return (
		turn.env.MUSE_HOME?.trim() ||
		turn.session.engineHomeDir?.trim() ||
		DEFAULT_MUSE_CONFIG_DIR
	);
}

/**
 * Explicit opt-in only: the URL must serve Muse's own protocol (`/muse-code/models`), so AgentHippo's
 * LiteLLM endpoints are deliberately not used here.
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveBaseUrl(turn) {
	const raw = process.env[BASE_URL_ENV]?.trim() || turn.env[BASE_URL_ENV]?.trim();
	return raw ? raw.replace(/\/$/, '') : undefined;
}

/**
 * Muse requires a UUID for `--session-id`; derive a stable one from the conversation key.
 * @param {string} seed
 */
function deterministicUuid(seed) {
	const hex = createHash('sha256').update(seed).digest('hex');
	const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`4${hex.slice(13, 16)}`,
		`${variant}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join('-');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveSessionId(turn) {
	const native = turn.session.nativeSessionId?.trim();
	if (native && UUID_RE.test(native)) {
		return native;
	}
	return deterministicUuid(
		turn.session.key || turn.session.contextSessionId || turn.session.chatSessionId || 'muse',
	);
}

function formatMissingAuthMessage() {
	const envFilePath = path.join(os.homedir(), '.agent-hippo', '.env');
	return [
		'**Muse Code** needs authentication before it can run.',
		'',
		'Option 1 — API key (CI / headless): add to `' + envFilePath + '`:',
		'',
		'```',
		`${META_API_KEY_ENV}=your_meta_model_api_key`,
		'```',
		'',
		'Create a key in the Meta Model API dashboard: https://dev.meta.ai/docs/muse-code',
		'',
		'Option 2 — Interactive login: run `muse login` in a terminal, then retry.',
		'',
		'Install the CLI if needed:',
		'```bash',
		'curl -fsSL https://dev.meta.ai/install.sh | bash',
		'```',
	].join('\n');
}

/**
 * Muse JSONL records are event-sourced envelopes:
 *   { schema_version, id, stream: { kind, id }, sequence, record_type, payload_type, payload: { kind, ... } }
 * Routing keys off `payload_type` (dotted) so unseen variants still land in the right bucket.
 * @param {Record<string, any>} payload
 */
function pickText(payload) {
	for (const value of [payload.delta, payload.text, payload.content, payload.message]) {
		if (typeof value === 'string' && value) {
			return value;
		}
		if (Array.isArray(value)) {
			const joined = value
				.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
				.filter(Boolean)
				.join('');
			if (joined) {
				return joined;
			}
		}
	}
	return '';
}

/**
 * @param {Record<string, any>} record
 * @param {import('./engine-contract.d.ts').Emitter} emitter
 * @param {import('./engine-contract.d.ts').Runtime} runtime
 * @param {{ nativeSessionId?: string, streamedText: boolean }} state
 */
async function mapStreamEvent(record, emitter, runtime, state) {
	const payloadType = String(record?.payload_type ?? '');
	const payload = record?.payload ?? {};

	if (record?.stream?.kind === 'session' && typeof record.stream.id === 'string' && UUID_RE.test(record.stream.id)) {
		state.nativeSessionId = record.stream.id;
	}

	// Assistant output: `run.output.delta` streams text; `run.terminal.*` carries the settled turn.
	if (payloadType === 'run.output.delta' || payloadType.startsWith('run.output.')) {
		const delta = pickText(payload);
		if (delta) {
			state.streamedText = true;
			await emitter.text(delta);
		}
		return;
	}

	if (payloadType.startsWith('run.terminal.')) {
		const terminal = String(payload.terminal ?? payloadType.split('.').pop() ?? '');
		const text = pickText(payload);
		if (terminal === 'completed') {
			// Deltas already streamed this text; only emit when the stream produced nothing.
			if (text && !state.streamedText) {
				state.streamedText = true;
				await emitter.text(text);
			}
			return;
		}
		const message = payload.reason || text || `Muse run ${terminal || 'failed'}`;
		await emitter.error(String(message));
		runtime.logger.error(`[Muse Code] run ${terminal}: ${message}`);
		return;
	}

	if (payloadType.includes('reasoning') || payloadType.includes('thinking')) {
		const delta = pickText(payload);
		if (delta) {
			await emitter.thinking(delta);
		}
		return;
	}

	if (payloadType.startsWith('tool.') || payloadType.startsWith('run.tool.')) {
		const name = String(payload.tool_name ?? payload.name ?? payload.tool ?? 'tool');
		const id = payload.tool_call_id ?? payload.call_id ?? payload.id ?? payload.task_id;
		const stage = payloadType.split('.').pop() ?? '';
		if (['started', 'requested', 'invoked', 'begin', 'call'].includes(stage)) {
			const input = payload.input ?? payload.arguments ?? payload.args ?? payload.params;
			await emitter.toolStart(name, typeof input === 'string' ? input : JSON.stringify(input ?? {}), id);
			return;
		}
		if (['completed', 'result', 'failed', 'end', 'settled'].includes(stage)) {
			const result = payload.result ?? payload.output ?? payload.content;
			await emitter.toolEnd(
				name,
				id,
				typeof result === 'string' ? result : JSON.stringify(result ?? ''),
				stage === 'failed' || Boolean(payload.is_error ?? payload.error),
			);
			return;
		}
	}

	// task.*/runtime.*/session.* are internal bookkeeping — a failed sub-task does not fail the turn.
	if (payloadType.startsWith('task.') || payloadType.startsWith('runtime.') || payloadType.startsWith('session.')) {
		logDebug(runtime, `[Muse Code] ${payloadType}`);
		return;
	}

	if (payloadType.endsWith('.error') || payloadType.endsWith('.failed')) {
		const message = pickText(payload) || payload.reason || `Muse Code error (${payloadType})`;
		await emitter.error(String(message));
		runtime.logger.error(`[Muse Code] ${payloadType}: ${message}`);
		return;
	}

	// Lifecycle/bookkeeping records (session.*, task.*, runtime.*, turn.input.user) are not user-visible.
	logDebug(runtime, `[Muse Code] ${payloadType || 'unknown record'}`);
}

export class MuseCodeCliEngine {
	/** @type {string | undefined | null} */
	#binaryPath = undefined;

	/** Only set when this engine started the shim — an externally run shim is never killed. */
	#shimProc = undefined;

	/**
	 * Muse needs an endpoint speaking its own protocol. When AgentHippo routes through LiteLLM there
	 * is no such endpoint, so the bundled shim supplies the catalog and forwards /responses. Returns
	 * the base URL to hand Muse, or undefined when the shim is unavailable.
	 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
	 */
	async #ensureShim(turn) {
		const { runtime } = turn;
		const url = `http://${SHIM_HOST}:${SHIM_PORT}`;

		if (await portIsOpen(SHIM_PORT)) {
			logDebug(runtime, `[Muse Code] Reusing shim already listening on ${SHIM_PORT}`);
			return url;
		}
		if (!existsSync(SHIM_SCRIPT)) {
			runtime.logger.warn(`[Muse Code] Shim script missing at ${SHIM_SCRIPT}`);
			return undefined;
		}

		// routing.* is empty on some hosts (observed via the CLI), so fall back to Spotlight's
		// conventional local LiteLLM before giving up.
		const litellmBase =
			turn.routing.openaiBaseUrl?.trim() ||
			turn.routing.baseUrl?.trim() ||
			turn.env.AGENTHIPPO_LITELLM_BASE_URL?.trim() ||
			process.env.AGENTHIPPO_LITELLM_BASE_URL?.trim() ||
			agentHippoEnvValue('AGENTHIPPO_LITELLM_BASE_URL') ||
			(await portIsOpen(4000) ? 'http://127.0.0.1:4000/v1' : undefined);
		if (!litellmBase) {
			runtime.logger.warn('[Muse Code] No LiteLLM base URL available for the shim');
			return undefined;
		}

		const proc = spawn(process.env.MUSE_SHIM_PYTHON || (IS_WIN ? 'python' : 'python3'), [SHIM_SCRIPT], {
			env: {
				...turn.env,
				SHIM_PORT: String(SHIM_PORT),
				LITELLM_BASE: litellmBase.replace(/\/$/, ''),
				// The shim talks to LiteLLM, so the LiteLLM key wins: routing.apiKey may carry a
				// borrowed provider key (observed: OPENAI_API_KEY), which LiteLLM rejects.
				LITELLM_KEY:
					turn.env.AGENTHIPPO_LITELLM_API_KEY ||
					process.env.AGENTHIPPO_LITELLM_API_KEY ||
					agentHippoEnvValue('AGENTHIPPO_LITELLM_API_KEY') ||
					turn.routing.apiKey ||
					'sk-dummy',
				SHIM_MODEL: turn.modelId,
				SHIM_AGENT_ID: turn.agent?.id || 'muse',
				...(turn.agent?.version ? { SHIM_AGENT_VERSION: turn.agent.version } : {}),
			},
			stdio: 'ignore',
			detached: false,
			windowsHide: true,
		});
		proc.unref();
		this.#shimProc = proc;

		// Poll rather than sleep: the interpreter usually binds in well under a second.
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (await portIsOpen(SHIM_PORT, 250)) {
				runtime.logger.info(`[Muse Code] Started LiteLLM shim on ${SHIM_PORT} -> ${litellmBase}`);
				return url;
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}

		runtime.logger.warn('[Muse Code] Shim did not start within 5s');
		this.#stopShim();
		return undefined;
	}

	#stopShim() {
		if (!this.#shimProc) {
			return;
		}
		try {
			this.#shimProc.kill('SIGTERM');
		} catch {
			// already gone
		}
		this.#shimProc = undefined;
	}

	/**
	 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
	 */
	async run(turn) {
		const { emitter, runtime, signal } = turn;
		const configDir = resolveMuseConfigDir(turn);
		let apiKey = resolveApiKey(turn);
		let baseUrl = resolveBaseUrl(turn);
		const provider = turn.env.MUSE_PROVIDER?.trim() || 'meta';

		// No explicit endpoint and no Meta credential: fall back to the bundled LiteLLM shim so the
		// selected AgentHippo model (e.g. ah-auto) serves the turn. MUSE_SHIM=0 opts out.
		if (
			provider === 'meta' &&
			!baseUrl &&
			!apiKey &&
			turn.env.MUSE_SHIM !== '0' &&
			!hasMuseLoginAuth(turn)
		) {
			const shimUrl = await this.#ensureShim(turn);
			if (shimUrl) {
				baseUrl = shimUrl;
				apiKey = SHIM_KEY;
			}
		}

		// The `echo` dry-run provider makes no model calls, so it needs no credentials.
		if (provider === 'meta' && !apiKey && !hasMuseLoginAuth(turn)) {
			runtime.logger.warn('[Muse Code] Skipping run: no META_API_KEY and no stored login credentials');
			await emitter.text(formatMissingAuthMessage());
			await emitter.done();
			return { nativeSessionId: turn.session.nativeSessionId };
		}

		if (this.#binaryPath === undefined) {
			this.#binaryPath = await findMuseBinary();
		}
		if (!this.#binaryPath) {
			throw new Error(
				'Muse Code CLI not found. Install: curl -fsSL https://dev.meta.ai/install.sh | bash. Set MUSE_CLI_PATH to override.',
			);
		}

		const sessionId = resolveSessionId(turn);
		const readOnly = turn.permissions?.fileAccess === 'read-only';
		const cliArgs = [
			'exec',
			'--json',
			'--session-id', sessionId,
			'--provider', provider,
			'--workspace', turn.workspaceRoot,
			'--approval-mode', 'never',
			'--trust-workspace',
			// Headless: auto-cancel request_user_input prompts instead of hanging the turn.
			'--user-input-auto-resolve',
		];
		// `muse exec` rejects --model/--base-url unless the provider is `meta`; `echo` is the offline dry-run provider.
		if (provider === 'meta') {
			cliArgs.push('--model', turn.modelId);
			if (baseUrl) {
				cliArgs.push('--base-url', baseUrl);
			}
		}
		if (readOnly) {
			cliArgs.push('--disable-write', '--disable-shell');
		}
		cliArgs.push(turn.message);

		const { command, args } = commandForSpawn(this.#binaryPath, cliArgs);
		runtime.logger.info(
			`[Muse Code] config=${configDir}, session=${sessionId}, cwd=${turn.workspaceRoot}, provider=${provider}, model=${turn.modelId}, litellm=${turn.routing.useLiteLLM ? 'yes' : 'no'}${baseUrl ? `, base_url=${baseUrl}` : ''}`,
		);

		/** @type {{ nativeSessionId?: string, streamedText: boolean }} */
		const streamState = { streamedText: false };

		await new Promise((resolve, reject) => {
			/** @type {Record<string, string>} */
			const childEnv = {
				...turn.env,
				MUSE_HOME: configDir,
				NO_COLOR: '1',
				FORCE_COLOR: '0',
				CI: '1',
			};
			if (apiKey) {
				// Muse refuses secrets as flag values; the key goes through the environment only.
				childEnv[META_API_KEY_ENV] = apiKey;
			} else {
				// Leaving an injected proxy key here makes Muse fail auth instead of using `muse login`.
				delete childEnv[META_API_KEY_ENV];
			}
			if (baseUrl) {
				childEnv[BASE_URL_ENV] = baseUrl;
			}

			const proc = spawn(command, args, {
				cwd: turn.workspaceRoot,
				env: childEnv,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});

			const abort = () => proc.kill('SIGTERM');
			signal?.addEventListener('abort', abort, { once: true });

			let stdoutBuffer = '';
			let stderr = '';

			proc.stdout.on('data', chunk => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split(/\r?\n/);
				stdoutBuffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}
					try {
						const event = JSON.parse(trimmed);
						void mapStreamEvent(event, emitter, runtime, streamState).catch(err => {
							runtime.logger.warn(
								`[Muse Code] Event mapping failed: ${err instanceof Error ? err.message : String(err)}`,
							);
						});
					} catch {
						logDebug(runtime, `[Muse Code] Non-JSON stdout: ${trimmed.slice(0, 200)}`);
					}
				}
			});

			proc.stderr.on('data', chunk => {
				const text = chunk.toString();
				stderr += text;
				for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
					logDebug(runtime, `[Muse Code] ${line}`);
				}
			});

			proc.on('error', error => {
				reject(new Error(`Failed to spawn muse (${command}): ${error.message}`));
			});

			proc.on('close', code => {
				signal?.removeEventListener('abort', abort);
				if (signal?.aborted) {
					reject(new Error('Muse Code run aborted'));
					return;
				}
				if (code === 0 || code === null) {
					resolve(code ?? 0);
					return;
				}
				reject(new Error((stderr || stdoutBuffer).trim() || `muse exited with code ${code}`));
			});
		});

		await emitter.done();
		return { nativeSessionId: streamState.nativeSessionId?.trim() || sessionId };
	}

	/** @param {import('./engine-contract.d.ts').Runtime['logger']} logger */
	onMaintenance(logger) {
		this.#binaryPath = undefined;
		logger.info('[Muse Code] Maintenance: binary path cache cleared');
	}

	dispose() {
		this.#binaryPath = undefined;
		this.#stopShim();
	}
}
