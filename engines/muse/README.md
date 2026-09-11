# Muse Code engine

AgentHippo custom engine for [Meta Muse Code](https://dev.meta.ai/docs/muse-code) — Meta's terminal
coding agent. Runs the CLI headlessly (`muse exec --json`), maps its JSONL event stream onto the
AgentHippo emitter, and keeps one Muse session per conversation so turns continue without replaying
history.

Muse's parallel subagents (`muse__subagent_spawn`, `muse__subagent_send_message`, …) are available
through this engine, so agents can fan out and message each other.

## Requirements

- **Muse Code CLI** — `curl -fsSL https://dev.meta.ai/install.sh | bash` (installs `~/.local/bin/muse`).
  Set `MUSE_CLI_PATH` if it lives elsewhere.
- **A model** — either a Meta credential, or a LiteLLM model via the bundled shim (below).
- **Python 3** — only when using the shim.

## Choosing a model source

Muse does not talk to arbitrary OpenAI endpoints. It fetches `GET <base-url>/muse-code/models` in its
own catalog format, then POSTs inference to `<base-url>/responses` (the OpenAI Responses API).

**Option 1 — Meta (default when credentials exist).** Run `muse login`, or set `META_API_KEY`.
Inference goes straight to Meta; the shim is never started.

**Option 2 — LiteLLM / Spotlight (automatic fallback).** With no Meta credential, the engine starts
`scripts/litellm-shim.py` on demand. The shim answers the catalog call and forwards `/responses` to
your LiteLLM proxy, so any LiteLLM model (e.g. `ah-auto`) can drive Muse. It reuses an already
listening shim and only stops one it started itself.

> The shim serves Muse a catalog it did not issue, so Muse runs against non-Meta models. Confirm this
> is acceptable under the Muse Code terms before relying on it.

## Configuration

| Variable | Purpose |
|---|---|
| `META_API_KEY` | Meta credential. Keys that merely mirror `OPENAI_API_KEY` / LiteLLM keys are ignored. |
| `MUSE_CLI_PATH` | Path to the `muse` binary. |
| `MUSE_BASE_URL` | Explicit Muse-protocol endpoint. Set it and the shim is skipped. |
| `MUSE_SHIM=0` | Never auto-start the shim. |
| `MUSE_SHIM_PORT` | Shim port (default `4399`). |
| `MUSE_SHIM_PYTHON` | Interpreter used to run the shim. |
| `MUSE_PROVIDER=echo` | Offline dry run — no model calls, no credentials needed. |
| `MUSE_AUTH_PATH` | Override the `muse login` credential path. |

Per-turn behaviour: `--approval-mode never` and `--trust-workspace` are always passed;
read-only agents additionally get `--disable-write --disable-shell`.

## Observability

Shim traffic is instrumented by LiteLLM, so it appears in Spotlight with cost, tokens and latency.
The shim adds `x-litellm-metadata-{source,engine,agent-id,session-id}`, so `--cost-by-engine` shows
`engine=muse` and `--cost-by-source` shows `source=agenthippo`.

Caveat: Muse mints a fresh session id per *run*, and exposes no parent id — one AgentHippo turn
therefore produces several Spotlight session rows (the main run plus Muse's internal reminder
subagents). Engine, source and cost rollups are exact; strict one-conversation-per-row is not.

Spotlight queries read an index, so run
`python3 "$AGENTIDE_ANALYTICS_SCRIPTS_DIR/index-traces.py"` before concluding traffic is missing.

The shim logs request metadata (no bodies, no credentials) to `~/.agent-hippo/muse-shim.log`
(mode `0600`); override with `SHIM_LOG`.

## Multi-agent notes

`muse__subagent_send_message` only reaches a subagent that is **still running** — messaging one that
has finished returns `target_missing` and the turn silently degrades to passing data through the
spawn payload instead. Give the receiving agent work to do (for example a first step that sleeps)
so the message lands mid-flight. A successful delivery returns
`{"status":"accepted","summary":"message queued through #NNNN"}`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Muse Code CLI not found` | CLI not installed, or set `MUSE_CLI_PATH`. |
| `failed to fetch model catalog: authentication failed` | Going direct to Meta with a rejected key. Run `muse login`, fix `META_API_KEY`, or clear it to use the shim. |
| `400 No connected db.` in the shim log | LiteLLM rejected the key; check `AGENTHIPPO_LITELLM_API_KEY` in `~/.agent-hippo/.env`. |
| Engine hangs or the shim never starts | Something else owns `MUSE_SHIM_PORT`; pick another port. |

## Limitations

- Verified on macOS (arm64) against Muse Code 1.1.1. Windows is coded for but untested.
- Muse Code is beta and closed-source; its catalog and JSONL event shapes are undocumented and may
  change between releases.
- The shim binds `127.0.0.1` and is unauthenticated — any local process can use it to spend your
  LiteLLM budget.
- A shim started during a one-shot CLI run can outlive it (`pkill -f litellm-shim` to stop).
