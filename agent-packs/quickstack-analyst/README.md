# quickstack-analyst

A read-only **orders analyst** that demonstrates AgentHippo's per-user data access: two
signed-in users ask the same question and each gets **only their own rows** — enforced by
Postgres Row-Level Security at the data layer, not by the prompt.

## What it demonstrates

- **Per-user rows, no per-user secrets.** The data-plane connector (`provider: identity`)
  maps the *verified* signed-in user to a Postgres role inside each query's own transaction
  (`SET LOCAL ROLE`); RLS decides which rows come back. There is no per-user credential to
  store, rotate, or leak.
- **The engine never holds a credential.** The engine gets a per-turn nonce; the broker owns
  the DB connection and the model call runs on a short-lived warrant. No database password
  and no provider API key exist inside the agent.
- **Engine-neutral.** `model: ah-auto` is resolved by the gateway per engine — swap
  `engine: codex` for another engine without touching the pack.

## Requirements

This pack uses the AgentHippo data plane, so it needs more than a bare engine:

- An AgentHippo deployment (e.g. the self-serve bundle from
  [control.agenthippo.ai](https://control.agenthippo.ai), or the
  [`quick-full-stack`](https://github.com/agenthippoai/agenthippo-deploy-samples) sample).
- A Postgres database with an `orders` table, per-user roles, and RLS policies. The
  `quick-full-stack` sample ships a complete working schema, seed data, and verification
  scripts — start there.
- Connector dependencies: run `npm install` in `mcp/mcp-postgres-rls/` on the machine that
  runs the agent (the deploy bundle's `bootstrap.sh` copies the pack as-is).

The MCP endpoint and turn auth are injected by the runtime (`AGENTHIPPO_DATA_MCP_URL`,
`AGENTHIPPO_TURN_NONCE`) — nothing to configure in this pack.

## Files

| Path | Purpose |
|---|---|
| `agent.yaml` | The pack manifest: engine, prompts, MCP, data-plane connector. |
| `AGENTS.md` | System prompt: single-statement `SELECT` only, never invent rows. |
| `mcp/postgres.mcp.json` | MCP client config — URL and bearer token come from the runtime env. |
| `mcp/mcp-postgres-rls/` | The broker-side connector: identity → `SET LOCAL ROLE`, RLS does the rest. |
| `www/index.html` | Minimal chat page for the optional browser edge (relative `/v1/chat`). |
