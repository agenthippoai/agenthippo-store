/**
 * Postgres RLS connector for the agenthippo serve data-plane gateway
 * (secure-obo-design §4 — the template for "any backend with no native OBO").
 *
 * TRUST DOMAIN: spawned by `agenthippo serve` (the BROKER), never by the engine. The
 * verified user arrives PER TOOL CALL in MCP `_meta["ai.agenthippo/turn"]`. There is no
 * per-user secret at all (provider: identity): the "credential exchange" is an
 * identity→role mapping executed inside the query's own transaction —
 *
 *   BEGIN;
 *     SET LOCAL ROLE u_<mapped>;                    -- row policies see this role
 *     SELECT set_config('app.user_email', $1, true) -- SET LOCAL, parameterized
 *     <query>
 *   COMMIT;
 *
 * SET LOCAL is transaction-scoped, so a pooled connection can never leak one user's
 * identity into another user's query. Postgres RLS (FORCE ROW LEVEL SECURITY) enforces
 * the rows — the data layer, never the prompt.
 *
 * Fail CLOSED: no broker-supplied user, or a user with no role mapping, refuses to run.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';

const SERVER_NAME = 'mcp-postgres-rls';
const SERVER_VERSION = '0.1.0';
const TURN_META_KEY = 'ai.agenthippo/turn';
const MAX_ROWS_DEFAULT = 1000;
// Hard ceiling regardless of what the model asks for: the result set is serialized into a tool
// response and back into the model's context, so an unbounded fetch is a cost and latency
// problem as well as a memory one. Kept identical to mcp-databricks-obo so the two connectors
// behave the same way for the same argument.
const MAX_ROWS_CEILING = 10_000;

function clampMaxRows(v) {
	if (v === undefined || v === null) { return MAX_ROWS_DEFAULT; }
	// `typeof v === 'number'` alone accepts -1, 0, 1e9, NaN and Infinity.
	if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
		throw new Error(`max_rows must be a positive integer (1..${MAX_ROWS_CEILING})`);
	}
	return Math.min(Math.floor(v), MAX_ROWS_CEILING);
}

/**
 * user → DB role map. Comes from PG_ROLE_MAP (JSON object) in the BROKER's env — the
 * mapping is authorization config owned by the operator, never by the pack prompt or
 * the model. A user absent from the map gets NO role and every query fails closed.
 */
function roleFor(userEmail) {
	let map;
	try {
		map = JSON.parse(process.env.PG_ROLE_MAP ?? '{}');
	} catch {
		throw new Error('PG_ROLE_MAP is not valid JSON (fail-closed)');
	}
	const role = map[userEmail];
	if (typeof role !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(role)) {
		throw new Error(`No DB role mapped for user (fail-closed): ${userEmail}`);
	}
	return role;
}

function requireUser(turn) {
	const userId = typeof turn?.userId === 'string' ? turn.userId.trim() : '';
	if (!userId) {
		throw new Error('No verified user on this tool call (fail-closed) — the serve data-plane gateway supplies it per turn.');
	}
	return userId;
}

function assertSelectOnly(query) {
	const trimmed = query.trim();
	if (!/^select\b/i.test(trimmed)) {
		throw new Error('Only read-only SELECT queries are allowed');
	}
	if (/\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|copy|set|reset)\b/i.test(trimmed)) {
		throw new Error('DDL/DML/SET statements are not allowed');
	}
	if (trimmed.includes(';')) {
		throw new Error('Multiple statements are not allowed');
	}
}

const pool = new pg.Pool({
	host: process.env.PGHOST ?? '127.0.0.1',
	port: Number(process.env.PGPORT ?? 55432),
	database: process.env.PGDATABASE ?? 'appdata',
	// The pool logs in as the privilege-less pool role; per-user authority exists only
	// inside a transaction via SET LOCAL ROLE.
	user: process.env.PGUSER ?? 'pool_login',
	password: process.env.PGPASSWORD ?? 'pool_login_dev_only',
	max: 5,
});

async function runQuery(turn, query, maxRows) {
	assertSelectOnly(query);
	const userEmail = requireUser(turn);
	const role = roleFor(userEmail);

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		// role passed the identifier allowlist regex in roleFor(); quote it as an identifier.
		await client.query(`SET LOCAL ROLE "${role}"`);
		// set_config(..., true) === SET LOCAL, but parameterized — no string interpolation.
		await client.query('SELECT set_config($1, $2, true)', ['app.user_email', userEmail]);
		const res = await client.query({ text: query, rowMode: 'array' });
		await client.query('COMMIT');
		const rows = res.rows.slice(0, maxRows);
		return {
			columns: res.fields.map((f) => f.name),
			rows,
			row_count: rows.length,
		};
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

const server = new Server(
	{ name: SERVER_NAME, version: SERVER_VERSION },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{ name: 'ping', description: 'Health check', inputSchema: { type: 'object', properties: {} } },
		{
			name: 'execute_sql',
			description: 'Execute a read-only SELECT against Postgres (runs under the current user\'s mapped role; RLS enforces rows)',
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'SQL SELECT query (single statement)' },
					max_rows: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CEILING, description: `Maximum rows to return (default ${MAX_ROWS_DEFAULT}, hard ceiling ${MAX_ROWS_CEILING})` },
				},
				required: ['query'],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const name = request.params.name;
	const args = request.params.arguments ?? {};
	const turn = (request.params._meta ?? {})[TURN_META_KEY];

	if (name === 'ping') {
		return { content: [{ type: 'text', text: JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION }) }] };
	}
	if (name !== 'execute_sql') {
		return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }) }], isError: true };
	}
	try {
		const query = typeof args.query === 'string' ? args.query : '';
		if (!query) {
			throw new Error('Missing required argument: query');
		}
		const maxRows = clampMaxRows(args.max_rows);
		const result = await runQuery(turn, query, maxRows);
		return {
			content: [{ type: 'text', text: JSON.stringify({ ok: true, query, result }, null, 2) }],
			structuredContent: { ok: true, query, result },
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true };
	}
});

await server.connect(new StdioServerTransport());
