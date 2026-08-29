---
name: agentic-workflow
description: Build multi-agent workflows by orchestrating AgentHippo CLI agent packs with explicit input/output contracts. Use when designing a new pipeline, testing packs individually before end-to-end runs, wiring fleet-workflow.sh for observability, or hooking Live Fleet 4 to monitor runs. Opinionated workflow-first; Live Fleet is optional visualization.
---

# Agentic Workflow (AgentHippo CLI)

**Opinionated approach:** A workflow is a **sequence of agent pack invocations** via `agenthippo ask`, not a Spotlight view. Each pack is a **specialist with a typed contract** (inputs → outputs on disk). Orchestration is a shell runner or coordinator pack. **Live Fleet 4** is an optional monitor that reads workflow status JSON — it does not run agents.

## Core principles

1. **Pack-first, workflow-second** — Build and test each agent pack alone before composing the pipeline. Optimize prompts, tools, and token use per pack with cheap one-shot runs; only then run end-to-end.
2. **Explicit I/O on disk** — Every step produces a **verifiable file** (or well-known path). Downstream steps read upstream artifacts; the orchestrator checks files exist before continuing.
3. **CLI is the integration layer** — Workers are always `agenthippo ask --agent <pack>`. No ad-hoc Python/Node in the runner unless documented as a pack fallback.
4. **Observability is separate** — `fleet-workflow.sh` writes human-readable JSON so Live Fleet 4 (or scripts) can show progress. Workflow correctness does not depend on Live Fleet.
5. **Same workspace by default** — Workers run with `--workspace "$ORIG"` when each step has **disjoint output paths**. Use a **git worktree** only when sub-tasks could **race on the same files**.

## Sub-agent workspace policy (required)

### Primary rule: file contention, not derived dirs

Choose isolation from **whether workers can edit the same paths at the same time**, not from whether they share a repo.

| Mode | When | `--workspace` |
|------|------|----------------|
| **direct** (default) | Each worker has **distinct** read/write targets; serial pipeline with non-overlapping outputs | `$ORIG` |
| **worktree** | Sub-tasks may **race** on the same file(s) — parallel steps, shared mutable path, or parent + worker both editing source | Git worktree + symlinked `data/` |
| **simple** | Stdout-only; **no** workspace file writes | `mktemp -d` + `ORIG_WORKSPACE` in prompt |

**Use worktree when any of these are true:**

- Two+ workers run **concurrently** and could touch the same path (same CSV, same module, same config).
- A worker edits **tracked source** while the parent/coordinator (or another worker) may edit the same paths.
- A step **appends or mutates** a file another step also writes (no exclusive ownership in the I/O table).

**Use direct when:**

- The I/O table gives each step **exclusive output paths** (e.g. `data/github-star/*.csv` then `.../charts/*.html`).
- Steps run **serially** and downstream only **reads** upstream artifacts (no concurrent writers).
- Workers only touch **disjoint** trees (`data/step-1/`, `data/step-2/`).

**Derived-dir note (secondary):** `agenthippo ask --workspace "$ORIG"` still syncs the worker pack into shared `.cursor`/`.claude`/`.codex` at the repo root. If the parent IDE is active on a **different pack**, that can stomp parent rules/skills. Prefer worktree when that matters; otherwise disjoint file I/O in one workspace is fine.

### Default: direct (same workspace)

```bash
ORIG="$(pwd)"
ASK=(agenthippo ask --engine cursor --model auto --workspace "$ORIG")

"${ASK[@]}" --agent github-star \
  "Collect 7-day stars for ${REPO}. Write CSV to data/github-star/ only."
```

Or via helper:

```bash
HELPER="extensions/agentide/base-prompts/skills/agentic-workflow/references/run-subagent.sh"
bash "$HELPER" direct --orig "$ORIG" --agent github-star --engine cursor --model auto -- \
  "Collect 7-day stars for ${REPO}. Write CSV to data/github-star/ only."
```

**I/O table must document exclusive paths** so “direct” stays safe. Add a column: **Contention?** (`none` | `same-file` → drives `direct` vs `worktree`).

### Worktree: same-file races only

Use `references/run-subagent.sh worktree` when the [worktree triggers](#use-worktree-when-any-of-these-are-true) apply:

```bash
AGENTHIPPO_WORKFLOW_ID=my-pipeline AGENTHIPPO_STEP=2 \
  bash "$HELPER" worktree --orig "$ORIG" --agent pack-a --engine cursor --model auto -- \
  "Refactor src/lib/foo.ts only. Do not touch other files."
```

The helper:

1. `git worktree add -b agenthippo/<workflow>/step-<N>-<ts> <tmp> HEAD`
2. Symlinks `data/`, `.agent-hippo/agents/`, fleet + analytics from `$ORIG`
3. Runs ask in the worktree (isolated checkout for contested paths)
4. Removes worktree + branch on exit

When using worktree, prefix prompts with `ORIG_WORKSPACE=<abs-path>.` for artifacts that must land under the main workspace (symlinked `data/`).

### Simple: stdout-only, no artifact files

```bash
bash "$HELPER" simple --orig "$ORIG" --agent joker1 --engine cursor --model auto -- \
  "Tell one short programming joke. Output to stdout only."
```

Do **not** use simple for steps that write `data/...` — use **direct** with disjoint paths instead.

### Anti-patterns

- Worktree for every serial step when outputs already live in separate paths (wastes setup; unnecessary)
- Direct mode with **overlapping write paths** in parallel workers
- Simple mode for pipeline artifacts under relative `data/`
- No **Contention?** column in the I/O table when mixing parallel workers

---

## Recommended development lifecycle

Follow this order (this is how robust workflows are built and debugged):

```
Phase 1 — Per-pack smoke tests (direct --workspace . OK if no parent)
  agenthippo ask "<minimal prompt>" --agent pack-a --workspace .
  → verify output file/schema; tune prompt; check Spotlight traces for cost/latency

Phase 2 — Per-pack contract tests
  Define input fixture + expected output path/format in pack AGENTS.md
  Repeat ask with --engine cursor --model auto (or pack defaults)
  Gate: output exists and passes a one-line check (wc -l, head, test -f)

Phase 3 — Wire I/O between steps (dry script)
  Runner passes pack-a output path in pack-b's prompt
  Mark Contention? per step; use worktree only where same-file race exists

Phase 4 — End-to-end workflow test
  fleet-workflow.sh init → steps (in_progress/done + --artifact) → finish
  Single runner script; workers direct by default, worktree when I/O table says same-file

Phase 5 — Live Fleet 4 (optional)
  start-live-fleet-4.sh; open Spotlight → Live Fleet 4 while re-running Phase 4
```

**Do not skip Phase 1–3.** Full-pipeline debugging without isolated pack tests wastes tokens and obscures which pack failed.

---

## Workflow design template

Before writing scripts, fill this table (one row per **worker** step; orchestrator is meta):

| Step | Pack id | Human label | Inputs (from) | Output path (absolute) | Contention? | Invoke |
|------|---------|-------------|---------------|------------------------|-------------|--------|
| 1 | joker1 | Warm-up joke | User topic | `data/<wf>/step-1.txt` | none | direct |
| 2 | github-star | Collect stars | `owner/repo` | `data/github-star/agenthippo-*.csv` | none | direct |
| 3 | star-visualizer | Plot chart | CSV glob (read-only) | `.../charts/star-data-widget.html` | none | direct |

Rules:
- **Inputs** must name the source: user message, env var, or prior step artifact path.
- **Output path** must be stable across runs (predictable naming) or discovered with one `ls` pattern documented in the runner.
- **Verification** is a shell check the orchestrator runs before `step … done`.
- **Contention?** `none` = disjoint paths, serial OK → **direct**. `same-file` = overlapping writes or parallel touch → **worktree**.

Document the same table in the **orchestrator pack** `AGENTS.md` and each **worker** pack `AGENTS.md` (step number + workflow id).

---

## Orchestration patterns

### Pattern A — Shell runner (recommended for CI and first e2e)

Single bash script: init fleet artifacts → for each step: `step in_progress` → worker invoke → verify file → `step done --artifact`. Reference: `scripts/run-star-pipeline-live-fleet-4.sh`.

```bash
ORIG="$(pwd)"
FW=".agent-hippo/scripts/fleet-workflow.sh"
ASK=(agenthippo ask --engine cursor --model auto --workspace "$ORIG")

"$FW" init --workflow my-pipeline --title "..." --subtitle "$RUN_CTX" --orchestrator my-coordinator
"$FW" step --workflow my-pipeline --step 1 --agent pack-a --label "..." --status in_progress

# Contention? none → direct (default)
"${ASK[@]}" --agent pack-a \
  "Write output only to data/my-pipeline/step-1.out. <task>"

OUT="$(cd "$ORIG" && pwd)/data/my-pipeline/step-1.out"
test -s "$OUT"
"$FW" step --workflow my-pipeline --step 1 --agent pack-a --label "..." --status done \
  --summary "..." --artifact "$OUT"
"$FW" finish --workflow my-pipeline --summary "Done"
```

For `Contention? same-file`, swap the ask line for `run-subagent.sh worktree` (see [Worktree: same-file races only](#worktree-same-file-races-only)).

### Pattern B — Coordinator agent pack

A dedicated pack (e.g. `star-coordinator`) whose `AGENTS.md` instructs the model to call **`agenthippo ask --workspace "$ORIG"`** (or `run-subagent.sh direct`) when steps have disjoint paths, and **`run-subagent.sh worktree`** only when the I/O table marks `same-file` contention. Use **simple** for stdout-only jokes. Use after Pattern A is proven; the shell runner remains the source of truth for automation.

**Step summaries must carry meaningful output summary.** After each `agenthippo ask`, copy the worker's substantive summary into `fleet-workflow.sh step --status done --summary`. For example, joker agent, use the **first non-empty line of the response** (the joke). Live Fleet 4 renders `--summary` verbatim — never write generic placeholders like `"Joke delivered"`, `"CSV ready"`, or `"Chart ready"`.

### CLI preflight

See `agenthippo-cli` skill. Minimum:

```bash
agenthippo --version
agenthippo ask "Reply OK" --agent <pack> --engine cursor --model auto --workspace .
```

---

## fleet-workflow.sh (observability contract)

Writes JSON under `.agent-hippo/fleet-workflows/`. Full schema: `references/workflow-json-schema.md`.

| Command | When |
|---------|------|
| `init` | Start of run |
| `orchestrator --status in_progress` | After init |
| `step --status in_progress` | **Before** worker invoke |
| `step --status done --summary --artifact` | **After** output verified |
| `finish` | All steps passed |

Use **absolute paths** for `--artifact` (always under `$ORIG`, not the worktree path). Step `--label` is human-facing (shown in Live Fleet).

**`--summary` is the human-readable step result** shown in Live Fleet 4. After `agenthippo ask`, extract the worker's key output into `--summary` (for joker1: the joke's first line). Do not use status placeholders.

Live Fleet 4 reads this JSON only — it never invokes packs. Hook-up summary in [Live Fleet 4 hook](#live-fleet-4-hook-optional) below.

---

## Reference workflow: `star-pipeline`

Proven e2e example in this repo. Use it as a copy template, not as the only valid workflow.

| Step | Pack | Input | Output | Contention? | Invoke |
|------|------|-------|--------|-------------|--------|
| — | star-coordinator | `owner/repo` | orchestrator status only | — | IDE |
| 1 | joker1 | joke prompt | stdout / optional file | none | simple or direct |
| 2 | github-star | `owner/repo`, 7 days | `data/github-star/agenthippo-*.csv` | none | **direct** |
| 3 | star-visualizer | CSV glob (read-only) | `.../charts/star-data-widget.html` | none | **direct** |

Serial pipeline; disjoint paths — no worktree required. Use worktree only if you parallelize steps that share a write target.

**Phase 1 / Phase 4 workers (direct):**

```bash
ORIG="$(pwd)"
ASK=(agenthippo ask --engine cursor --model auto --workspace "$ORIG")

"${ASK[@]}" --agent github-star \
  "Collect 7-day stars for vercel/next.js. Write CSV to data/github-star/ only."
```

**Phase 4 e2e:**

```bash
STAR_TEST_REPO=vercel/next.js bash scripts/run-star-pipeline-live-fleet-4.sh
```

Packs live under `.agent-hippo/agents/{joker1,github-star,star-visualizer,star-coordinator}/`.

---

## Create a new workflow (checklist)

1. **Name** — `workflowId` (kebab-case), title, orchestrator pack id.
2. **I/O table** — One row per worker; no step without a defined output file.
3. **Scaffold packs** — Use `agentpack-creator` skill; add workflow section to each `AGENTS.md` (exclusive output paths per step).
4. **Phase 1–3** — Smoke + contract test each pack; use `agentpack-testbench` or manual `agenthippo ask`.
5. **Runner script** — Copy `references/new-workflow-template.sh`; default `direct`, pass `worktree` only for `same-file` rows.
6. **Phase 4 e2e** — Run runner; confirm artifacts chain under `$ORIG`; `fleet-workflow.sh finish` archives to `history/`.
7. **Phase 5 (optional)** — Live Fleet 4 daemon + visual check.

Anti-patterns:
- Monolithic mega-prompt covering all steps in one `ask`
- Skipping file outputs (stdout-only steps break verification and Live Fleet links)
- Hand-editing workflow JSON during a run
- Tuning the full pipeline before individual packs pass contract tests
- Worktree on every step when the I/O table already partitions files (no contention)
- Direct mode with parallel workers assigned the same output path

---

## Live Fleet 4 hook (optional)

After Phase 4 passes without UI:

```bash
.agent-hippo/scripts/start-live-fleet-4.sh --restart
# Re-run e2e runner; open Spotlight → Live Fleet 4
```

Requirements for visualization (not for workflow logic):

| Item | Detail |
|------|--------|
| Artifacts | `.agent-hippo/fleet-workflows/` + `history/` via `fleet-workflow.sh` |
| Daemon | `start-live-fleet-4.sh` for near-real-time export refresh |
| View | `.agent-hippo/analytics/views/live-fleet-4/` (`preserveFleetIframe: true`) |

Running lane = active `<workflowId>.json`; Finished lane = archived history. Step **output** links need absolute `--artifact` paths under `$ORIG`.

---

## Related skills & paths

| Resource | Path / skill |
|----------|----------------|
| CLI install | `agenthippo-cli` |
| New pack | `agentpack-creator` |
| Pack tests | `agentpack-testbench` |
| Trace/cost tuning | `spotlight-query`, `prompt-lab`, `debug-agent` |
| **Sub-agent runner** | `references/run-subagent.sh` |
| Workflow writer | `.agent-hippo/scripts/fleet-workflow.sh` |
| JSON schema | `references/workflow-json-schema.md` |
| Runner template | `references/new-workflow-template.sh` |
| Star e2e runner | `scripts/run-star-pipeline-live-fleet-4.sh` |
| Live Fleet daemon | `.agent-hippo/scripts/start-live-fleet-4.sh` |
