// @ts-check
/**
 * Cursor SDK engine bridge for AgentHippo.
 *
 * Uses @cursor/sdk in-process with local runtime. AgentHippo owns the outer
 * conversation key; Cursor owns agent state via agentId (nativeSessionId).
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';

const SDK_PACKAGE = '@cursor/sdk';
const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_SESSION_IDLE_TTL_MS = 1000 * 60 * 30;

/** @type {Promise<{ Agent: typeof import('@cursor/sdk').Agent, CursorAgentError: typeof import('@cursor/sdk').CursorAgentError }> | undefined} */
let sdkPromise;

function platformToolsDir() {
	switch (process.platform) {
		case 'darwin':
			return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
		case 'linux':
			return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
		case 'win32':
			return 'win32-x64';
		default:
			return undefined;
	}
}

/**
 * Cursor SDK local runtime needs ripgrep on PATH for ignore-file indexing.
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 */
function ensureRipgrepOnPath(turn) {
	const explicit = turn.env.CURSOR_RG_PATH?.trim();
	if (explicit && existsSync(explicit)) {
		prependPath(path.dirname(explicit));
		return;
	}

	const toolsName = platformToolsDir();
	const candidates = [
		toolsName ? path.join(turn.workspaceRoot, 'extensions', 'agentide', 'tools', toolsName) : undefined,
		toolsName ? path.join(ENGINE_DIR, '..', '..', '..', 'extensions', 'agentide', 'tools', toolsName) : undefined,
	].filter((dir) => dir && existsSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg')));

	for (const dir of candidates) {
		prependPath(dir);
	}
}

/** @param {string} dir */
function prependPath(dir) {
	const sep = process.platform === 'win32' ? ';' : ':';
	const current = process.env.PATH ?? '';
	if (!current.split(sep).includes(dir)) {
		process.env.PATH = `${dir}${sep}${current}`;
	}
}

async function loadSdk() {
	if (!sdkPromise) {
		sdkPromise = import(SDK_PACKAGE).then((mod) => ({
			Agent: mod.Agent,
			CursorAgentError: mod.CursorAgentError,
		})).catch((err) => {
			sdkPromise = undefined;
			throw new Error(
				`Missing ${SDK_PACKAGE}. Run: npm install --prefix .agent-hippo/engines/cursor. ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}
	return sdkPromise;
}

/**
 * @param {string | undefined} value
 */
function isValidCursorApiKey(value) {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === 'sk-dummy') {
		return false;
	}
	return trimmed.startsWith('crsr_');
}

/**
 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
 * @returns {string | undefined}
 */
function resolveApiKey(turn) {
	// AgentHippo may copy the LiteLLM/Anthropic routing key into turn.env.CURSOR_API_KEY
	// via manifest apiKeyEnvVar. Prefer the real Cursor key from the process environment.
	const candidates = [
		process.env[CURSOR_API_KEY_ENV],
		turn.env[CURSOR_API_KEY_ENV],
	].map((value) => value?.trim()).filter(Boolean);

	for (const key of candidates) {
		if (isValidCursorApiKey(key)) {
			return key;
		}
	}

	const fromRouting = turn.routing.apiKey?.trim();
	if (isValidCursorApiKey(fromRouting)) {
		return fromRouting;
	}

	return undefined;
}

function formatMissingCursorApiKeyMessage() {
	const home = os.homedir();
	const envFilePath = `~${path.join(home, '.agent-hippo', '.env').slice(home.length)}`;
	return [
		'**Cursor** needs a Cursor API key before it can run.',
		'',
		`Add this line to \`${envFilePath}\` (create the file if it does not exist):`,
		'',
		'```',
		`${CURSOR_API_KEY_ENV}=crsr_your_key_here`,
		'```',
		'',
		'Get a key from the Cursor dashboard (user or service account). Keys start with `crsr_`.',
		'',
		`If \`${CURSOR_API_KEY_ENV}\` is already set in your shell environment, fix or unset it there too — shell values take priority over \`${envFilePath}\`.`,
		'',
		'Save the file, then send your message again.',
	].join('\n');
}

/**
 * @param {unknown} value
 */
function toJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * @param {import('@cursor/sdk').SDKMessage} event
 * @param {import('./engine-contract.d.ts').Emitter} emitter
 * @param {Set<string>} openToolCalls
 */
async function mapStreamEvent(event, emitter, openToolCalls) {
	switch (event.type) {
		case 'assistant': {
			for (const block of event.message.content ?? []) {
				if (block.type === 'text' && typeof block.text === 'string' && block.text) {
					await emitter.text(block.text);
				}
			}
			return;
		}
		case 'thinking': {
			if (typeof event.text === 'string' && event.text) {
				await emitter.thinking(event.text);
			}
			return;
		}
		case 'tool_call': {
			const callId = String(event.call_id ?? '');
			const name = String(event.name ?? 'tool');
			if (event.status === 'running') {
				openToolCalls.add(callId);
				await emitter.toolStart(name, event.args == null ? undefined : toJson(event.args), callId);
				return;
			}
			openToolCalls.delete(callId);
			await emitter.toolEnd(
				name,
				callId,
				event.result == null ? undefined : toJson(event.result),
				event.status === 'error',
			);
			return;
		}
		case 'status': {
			if (event.message) {
				await emitter.progress(`${event.status}: ${event.message}`);
			}
			return;
		}
		case 'task': {
			if (event.text) {
				await emitter.progress(event.text);
			}
			return;
		}
		case 'system':
		case 'user':
		case 'request':
			return;
		default:
			return;
	}
}

export class CursorSdkEngine {
	/** @type {Map<string, { agent: import('@cursor/sdk').SDKAgent, nativeSessionId: string, apiKeyHash: string, lastUsedAt: number }>} */
	#sessions = new Map();

	/**
	 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
	 */
	async run(turn) {
		const { emitter, runtime, signal } = turn;
		const apiKey = resolveApiKey(turn);
		if (!apiKey) {
			runtime.logger.warn('[Cursor SDK] Skipping run: missing or invalid CURSOR_API_KEY');
			await emitter.text(formatMissingCursorApiKeyMessage());
			await emitter.done();
			return { nativeSessionId: turn.session.nativeSessionId };
		}

		const { Agent, CursorAgentError } = await loadSdk();
		ensureRipgrepOnPath(turn);
		const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
		const model = { id: turn.modelId };
		const local = {
			cwd: turn.workspaceRoot,
			settingSources: ['project'],
		};

		let state = this.#sessions.get(turn.session.key);
		if (!state) {
			state = await this.#openAgent(Agent, CursorAgentError, turn, apiKey, model, local, apiKeyHash);
			this.#sessions.set(turn.session.key, state);
		} else if (state.apiKeyHash !== apiKeyHash) {
			await this.#disposeAgent(state.agent);
			state = await this.#openAgent(Agent, CursorAgentError, turn, apiKey, model, local, apiKeyHash);
			this.#sessions.set(turn.session.key, state);
		}
		state.lastUsedAt = Date.now();

		const openToolCalls = new Set();
		let sawAssistantText = false;
		let run;
		try {
			run = await state.agent.send(turn.message, { model });
		} catch (err) {
			if (err instanceof CursorAgentError) {
				throw new Error(`Cursor SDK startup failed: ${err.message}`);
			}
			throw err;
		}

		const onAbort = () => {
			void (async () => {
				try {
					if (run.supports('cancel')) {
						await run.cancel();
					}
				} catch (abortErr) {
					runtime.logger.warn(`[Cursor SDK] Cancel failed: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
				}
			})();
		};
		signal?.addEventListener('abort', onAbort, { once: true });

		try {
			for await (const event of run.stream()) {
				if (signal?.aborted) {
					break;
				}
				if (event.type === 'assistant') {
					for (const block of event.message.content ?? []) {
						if (block.type === 'text' && typeof block.text === 'string' && block.text) {
							sawAssistantText = true;
						}
					}
				}
				await mapStreamEvent(event, emitter, openToolCalls);
			}

			if (signal?.aborted) {
				throw new Error('Cursor SDK run aborted');
			}

			const result = await run.wait();
			if (result.status === 'error') {
				let detail = '';
				if (run.supports('conversation')) {
					try {
						const turns = await run.conversation();
						const last = turns[turns.length - 1];
						detail = last ? ` lastTurn=${JSON.stringify(last).slice(0, 400)}` : '';
					} catch { /* optional */ }
				}
				throw new Error(`Cursor SDK run failed (run=${result.id}, model=${turn.modelId})${detail}`);
			}
			if (result.status === 'cancelled') {
				throw new Error('Cursor SDK run cancelled');
			}

			if (!sawAssistantText && typeof result.result === 'string' && result.result.trim()) {
				await emitter.text(result.result);
			}
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}

		state.nativeSessionId = state.agent.agentId;
		await emitter.done();
		return { nativeSessionId: state.nativeSessionId };
	}

	/**
	 * @param {typeof import('@cursor/sdk').Agent} Agent
	 * @param {typeof import('@cursor/sdk').CursorAgentError} CursorAgentError
	 * @param {import('./engine-contract.d.ts').CustomEngineTurn} turn
	 * @param {string} apiKey
	 * @param {{ id: string }} model
	 * @param {{ cwd: string, settingSources: string[] }} local
	 * @param {string} apiKeyHash
	 */
	async #openAgent(Agent, CursorAgentError, turn, apiKey, model, local, apiKeyHash) {
		const nativeId = turn.session.nativeSessionId?.trim();
		if (nativeId) {
			try {
				const agent = await Agent.resume(nativeId, { apiKey, model, local });
				turn.runtime.logger.info(`[Cursor SDK] Resumed agent ${nativeId}`);
				return { agent, nativeSessionId: agent.agentId, apiKeyHash, lastUsedAt: Date.now() };
			} catch (err) {
				if (!(err instanceof CursorAgentError)) {
					throw err;
				}
				turn.runtime.logger.warn(
					`[Cursor SDK] Resume failed for ${nativeId}: ${err.message}; creating new agent`,
				);
			}
		}

		const agent = await Agent.create({ apiKey, model, local });
		turn.runtime.logger.info(`[Cursor SDK] Created agent ${agent.agentId} cwd=${turn.workspaceRoot}`);
		return { agent, nativeSessionId: agent.agentId, apiKeyHash, lastUsedAt: Date.now() };
	}

	/**
	 * @param {import('@cursor/sdk').SDKAgent} agent
	 */
	async #disposeAgent(agent) {
		try {
			await agent[Symbol.asyncDispose]();
		} catch { /* best effort */ }
	}

	/** @param {import('./engine-contract.d.ts').Runtime['logger']} logger */
	onMaintenance(logger) {
		const now = Date.now();
		for (const [key, state] of this.#sessions.entries()) {
			if (now - state.lastUsedAt <= ACTIVE_SESSION_IDLE_TTL_MS) {
				continue;
			}
			void this.#disposeAgent(state.agent);
			this.#sessions.delete(key);
			logger.info(`[Cursor SDK] Closed idle session (key=${key})`);
		}
	}

	dispose() {
		for (const state of this.#sessions.values()) {
			void this.#disposeAgent(state.agent);
		}
		this.#sessions.clear();
	}
}
