// @ts-nocheck
/**
 * Regression tests for the Cursor engine's data-plane MCP wiring.
 * Run: node --test engines/cursor/engine.test.mjs
 *
 * Guards the fix that made the AgentHippo data-plane gateway reach the Cursor engine:
 * (1) turn.mcpServers is mapped into the Cursor SDK's AgentOptions.mcpServers shape, and
 * (2) the config signature changes with the per-turn auth nonce so a warm agent is re-opened
 *     (with the fresh nonce) instead of replaying a stale one and 401-ing on turn 2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCursorMcpServers, mcpConfigSignature } from './engine.mjs';

test('http gateway server maps to the Cursor {type:http,url,headers} shape', () => {
	const inline = {
		demo: { type: 'http', url: 'http://127.0.0.1:5000/mcp', headers: { Authorization: 'Bearer nonce-1' } },
	};
	assert.deepEqual(buildCursorMcpServers(inline), {
		demo: { type: 'http', url: 'http://127.0.0.1:5000/mcp', headers: { Authorization: 'Bearer nonce-1' } },
	});
});

test('stdio server maps to {command,args,env}', () => {
	const inline = { local: { command: 'node', args: ['s.js'], env: { X: '1' } } };
	assert.deepEqual(buildCursorMcpServers(inline), { local: { command: 'node', args: ['s.js'], env: { X: '1' } } });
});

test('undefined / empty input yields undefined (no mcpServers option passed to the SDK)', () => {
	assert.equal(buildCursorMcpServers(undefined), undefined);
	assert.equal(buildCursorMcpServers({}), undefined);
	assert.equal(buildCursorMcpServers({ bad: { nope: true } }), undefined);
});

test('signature changes when the per-turn nonce changes → warm agent is re-opened, not replayed stale', () => {
	const t1 = buildCursorMcpServers({ demo: { type: 'http', url: 'u', headers: { Authorization: 'Bearer nonce-1' } } });
	const t2 = buildCursorMcpServers({ demo: { type: 'http', url: 'u', headers: { Authorization: 'Bearer nonce-2' } } });
	assert.notEqual(mcpConfigSignature(t1), mcpConfigSignature(t2), 'a changed nonce must bust the agent cache');
});

test('signature is stable for identical config (warm-agent fast path kept for non-data-plane packs)', () => {
	const a = buildCursorMcpServers({ x: { command: 'node', args: ['s.js'] } });
	const b = buildCursorMcpServers({ x: { command: 'node', args: ['s.js'] } });
	assert.equal(mcpConfigSignature(a), mcpConfigSignature(b));
	assert.equal(mcpConfigSignature(undefined), 'none');
});

test('manifest declares NO apiKeyEnvVar — CURSOR_API_KEY is operator-owned, never a host delivery slot', async () => {
	const { readFileSync } = await import('node:fs');
	const manifest = JSON.parse(readFileSync(new URL('./engine.manifest.json', import.meta.url), 'utf8'));
	assert.equal(manifest.model?.apiKeyEnvVar, undefined,
		'declaring apiKeyEnvVar tells the host to WRITE the model-routing key there, clobbering the operator\'s crsr_ key');
});
