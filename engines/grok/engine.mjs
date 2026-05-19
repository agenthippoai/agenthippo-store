// @ts-check
/**
 * xAI Grok Build CLI engine bridge for AgentHippo.
 *
 * Spawns the official Grok Build CLI (install: curl -fsSL https://x.ai/cli/install.sh | bash)
 * in headless mode with streaming-json output.
 *
 * Docs: https://docs.x.ai/build/cli/headless-scripting
 * LiteLLM: set GROK_MODELS_BASE_URL to your OpenAI-compatible proxy (e.g. http://127.0.0.1:4000/v1)
 *
 * Session continuity: Grok Build starts a chat with `-s <label>` but only continues history
 * with `-r <sessionId>` where sessionId is the UUID from the prior stream's `end` event.
 * AgentHippo persists that UUID; this bridge resumes with `-r` on later turns.
 */

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const CLI_BIN = 'grok';
const XAI_API_KEY_ENV = 'XAI_API_KEY';
const MODELS_BASE_ENV = 'GROK_MODELS_BASE_URL';
const DEFAULT_GROK_HOME = path.join(os.homedir(), '.grok');

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

async function findGrokBinary() {
	const explicit = expandHome(process.env.GROK_CLI_PATH);
	if (explicit && existsSync(explicit)) {
		return explicit;
	}

	const candidates = [
		path.join(os.homedir(), '.grok', 'bin', IS_WIN ? 'grok.exe' : 'grok'),
		path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'grok.exe' : 'grok'),
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
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function hasGrokLoginAuth(engineHome) {
	return existsSync(path.join(engineHome, 'auth.json'));
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveApiKey(turn) {
	if (turn.routing.useLiteLLM) {
		return (
			turn.routing.apiKey?.trim() ||
			turn.env[XAI_API_KEY_ENV]?.trim() ||
			turn.env.AGENTHIPPO_LITELLM_API_KEY?.trim() ||
			'sk-dummy'
		);
	}

	const candidates = [
		process.env[XAI_API_KEY_ENV],
		turn.env[XAI_API_KEY_ENV],
		turn.routing.apiKey,
	].map(value => value?.trim()).filter(Boolean);

	for (const key of candidates) {
		if (key && key !== 'sk-dummy') {
			return key;
		}
	}
	return undefined;
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveGrokHome(turn) {
	return (
		turn.env.GROK_HOME?.trim() ||
		turn.session.engineHomeDir?.trim() ||
		DEFAULT_GROK_HOME
	);
}

/**
 * OpenAI-compatible models/inference base URL (required for LiteLLM routing).
 * grok-build uses api.x.ai/responses by default; GROK_MODELS_BASE_URL redirects to a proxy.
 * @param {string | undefined} url
 */
function normalizeModelsBaseUrl(url) {
	if (!url?.trim()) {
		return undefined;
	}
	const trimmed = url.trim().replace(/\/$/, '');
	return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function resolveModelsBaseUrl(turn) {
	if (!turn.routing.useLiteLLM) {
		return undefined;
	}
	const raw =
		turn.routing.openaiBaseUrl?.trim() ||
		turn.routing.baseUrl?.trim() ||
		turn.env[MODELS_BASE_ENV]?.trim() ||
		turn.env.AGENTHIPPO_LITELLM_BASE_URL?.trim() ||
		turn.env.AGENTIDE_LITELLM_BASE_URL?.trim() ||
		undefined;
	return normalizeModelsBaseUrl(raw);
}

/**
 * Stable label for the first turn in an AgentHippo conversation (`-s`).
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function newSessionLabel(turn) {
	const hash = createHash('sha256')
		.update(turn.session.key || turn.session.contextSessionId || turn.session.chatSessionId || 'grok')
		.digest('hex')
		.slice(0, 24);
	return `agenthippo-${hash}`;
}

/**
 * Grok `end.sessionId` values are UUIDs. AgentHippo-prefixed labels are only for `-s`.
 * @param {string | undefined} id
 */
function isResumableGrokSessionId(id) {
	const trimmed = id?.trim();
	if (!trimmed) {
		return false;
	}
	return !trimmed.startsWith('agenthippo-');
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 * @returns {{ mode: 'resume' | 'start', flag: '-r' | '-s', sessionId: string }}
 */
function resolveSessionCliArgs(turn) {
	const native = turn.session.nativeSessionId?.trim();
	if (native && isResumableGrokSessionId(native)) {
		return { mode: 'resume', flag: '-r', sessionId: native };
	}
	const label = native?.startsWith('agenthippo-') ? native : newSessionLabel(turn);
	return { mode: 'start', flag: '-s', sessionId: label };
}

function formatMissingAuthMessage() {
	const envFilePath = path.join(os.homedir(), '.agent-hippo', '.env');
	return [
		'**Grok Build** needs authentication before it can run.',
		'',
		'Option 1 — API key (CI / headless): add to `' + envFilePath + '`:',
		'',
		'```',
		`${XAI_API_KEY_ENV}=xai_your_key_here`,
		'```',
		'',
		'Get a key from https://console.x.ai/team/default/api-keys',
		'',
		'Option 2 — Interactive login: run `grok login` in a terminal, then retry.',
		'',
		'Install the CLI if needed:',
		'```bash',
		'curl -fsSL https://x.ai/cli/install.sh | bash',
		'```',
	].join('\n');
}

/**
 * @param {Record<string, unknown>} event
 * @param {import('./engine-contract.d.ts').Emitter} emitter
 * @param {import('./engine-contract.d.ts').Runtime} runtime
 * @param {{ nativeSessionId?: string, textChunks: string[] }} state
 */
async function mapStreamEvent(event, emitter, runtime, state) {
	switch (event.type) {
		case 'text': {
			const delta = typeof event.data === 'string' ? event.data : '';
			if (delta) {
				state.textChunks.push(delta);
				await emitter.text(delta);
			}
			return;
		}
		case 'thought': {
			const delta = typeof event.data === 'string' ? event.data : '';
			if (delta) {
				await emitter.thinking(delta);
			}
			return;
		}
		case 'end': {
			const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
			if (sessionId) {
				state.nativeSessionId = sessionId;
			}
			return;
		}
		case 'error': {
			const message = typeof event.message === 'string'
				? event.message
				: typeof event.data === 'string'
					? event.data
					: 'Grok CLI error';
			await emitter.error(message);
			runtime.logger.error(`[Grok Build] ${message}`);
			return;
		}
		default:
			runtime.logger.debug(`[Grok Build] Unhandled event: ${JSON.stringify(event)}`);
	}
}

export class GrokCliEngine {
	/** @type {string | undefined | null} */
	#binaryPath = undefined;

	/**
	 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
	 */
	async run(turn) {
		const { emitter, runtime, signal } = turn;
		const grokHome = resolveGrokHome(turn);
		const apiKey = resolveApiKey(turn);
		const modelsBaseUrl = resolveModelsBaseUrl(turn);

		if (!apiKey && !hasGrokLoginAuth(grokHome)) {
			runtime.logger.warn('[Grok Build] Skipping run: no XAI_API_KEY and no ~/.grok/auth.json');
			await emitter.text(formatMissingAuthMessage());
			await emitter.done();
			return { nativeSessionId: turn.session.nativeSessionId };
		}

		if (this.#binaryPath === undefined) {
			this.#binaryPath = await findGrokBinary();
		}
		if (!this.#binaryPath) {
			throw new Error(
				'Grok Build CLI not found. Install: curl -fsSL https://x.ai/cli/install.sh | bash. Set GROK_CLI_PATH to override.',
			);
		}

		const sessionCli = resolveSessionCliArgs(turn);
		const cliArgs = [
			'-p', turn.message,
			'--output-format', 'streaming-json',
			'--always-approve',
			'--cwd', turn.workspaceRoot,
			'-m', turn.modelId,
			sessionCli.flag, sessionCli.sessionId,
		];

		const { command, args } = commandForSpawn(this.#binaryPath, cliArgs);
		runtime.logger.info(
			`[Grok Build] home=${grokHome}, session=${sessionCli.sessionId} (${sessionCli.mode}), cwd=${turn.workspaceRoot}, model=${turn.modelId}, litellm=${turn.routing.useLiteLLM ? 'yes' : 'no'}${modelsBaseUrl ? `, models_base=${modelsBaseUrl}` : ''}`,
		);

		/** @type {{ nativeSessionId?: string, textChunks: string[] }} */
		const streamState = { textChunks: [] };

		const exitCode = await new Promise((resolve, reject) => {
			/** @type {Record<string, string>} */
			const childEnv = {
				...turn.env,
				GROK_HOME: grokHome,
				NO_COLOR: '1',
				FORCE_COLOR: '0',
				CI: '1',
			};
			if (apiKey) {
				childEnv[XAI_API_KEY_ENV] = apiKey;
			}
			if (modelsBaseUrl) {
				childEnv[MODELS_BASE_ENV] = modelsBaseUrl;
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
								`[Grok Build] Event mapping failed: ${err instanceof Error ? err.message : String(err)}`,
							);
						});
					} catch {
						runtime.logger.debug(`[Grok Build] Non-JSON stdout: ${trimmed.slice(0, 200)}`);
					}
				}
			});

			proc.stderr.on('data', chunk => {
				const text = chunk.toString();
				stderr += text;
				for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
					runtime.logger.debug(`[Grok Build] ${line}`);
				}
			});

			proc.on('error', error => {
				reject(new Error(`Failed to spawn grok (${command}): ${error.message}`));
			});

			proc.on('close', code => {
				signal?.removeEventListener('abort', abort);
				if (signal?.aborted) {
					reject(new Error('Grok Build run aborted'));
					return;
				}
				if (code === 0 || code === null) {
					resolve(code ?? 0);
					return;
				}
				reject(new Error((stderr || stdoutBuffer).trim() || `grok exited with code ${code}`));
			});
		});

		if (exitCode !== 0) {
			throw new Error(`grok failed with exit code ${exitCode}`);
		}

		await emitter.done();
		const nativeSessionId = streamState.nativeSessionId?.trim();
		if (!nativeSessionId) {
			runtime.logger.warn('[Grok Build] No sessionId in stream end event; conversation may not resume on next turn');
		}
		return { nativeSessionId: nativeSessionId || turn.session.nativeSessionId };
	}

	/** @param {import('./engine-contract.d.ts').Runtime['logger']} logger */
	onMaintenance(logger) {
		this.#binaryPath = undefined;
		logger.info('[Grok Build] Maintenance: binary path cache cleared');
	}

	dispose() {
		this.#binaryPath = undefined;
	}
}
