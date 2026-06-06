#!/usr/bin/env bash
# Template: AgentHippo CLI multi-agent workflow (Phase 4 e2e).
# Phase 1–3: test each pack alone with agenthippo ask before using this script.
# Workers: direct (default) when I/O paths are disjoint; worktree when Contention? = same-file.
# Copy to scripts/run-<workflow-id>.sh and replace placeholders.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- CONFIG (replace) ---
WORKFLOW_ID="my-pipeline"
TITLE="My Pipeline"
SUBTITLE="${RUN_INPUT:-example-input}"
ORCHESTRATOR="my-coordinator"
ENGINE="${AGENTHIPPO_ENGINE:-cursor}"
MODEL="${AGENTHIPPO_MODEL:-auto}"
FW="$ROOT/.agent-hippo/scripts/fleet-workflow.sh"
SUBAGENT="$ROOT/extensions/agentide/base-prompts/skills/agentic-workflow/references/run-subagent.sh"
if [[ ! -x "$SUBAGENT" ]]; then
  SUBAGENT="$ROOT/.agent-hippo/agents/default/skills/agentic-workflow/references/run-subagent.sh"
fi
ASK=(agenthippo ask --engine "$ENGINE" --model "$MODEL" --workspace "$ROOT")

abs() { python3 -c "import os,sys; print(os.path.abspath(sys.argv[1]))" "$1"; }

# invoke_mode: direct | worktree | simple
run_worker() {
  local step="$1" pack="$2" label="$3" prompt="$4" out_rel="$5" invoke_mode="${6:-direct}"
  local out
  out="$(abs "$ROOT/$out_rel")"

  "$FW" step --workflow "$WORKFLOW_ID" --step "$step" --agent "$pack" \
    --label "$label" --status in_progress

  case "$invoke_mode" in
    direct)
      "${ASK[@]}" --agent "$pack" "$prompt"
      ;;
    worktree)
      AGENTHIPPO_WORKFLOW_ID="$WORKFLOW_ID" AGENTHIPPO_STEP="$step" \
        bash "$SUBAGENT" worktree --orig "$ROOT" --agent "$pack" \
        --engine "$ENGINE" --model "$MODEL" -- "$prompt"
      ;;
    simple)
      bash "$SUBAGENT" simple --orig "$ROOT" --agent "$pack" \
        --engine "$ENGINE" --model "$MODEL" -- "$prompt"
      ;;
    *)
      echo "Unknown invoke_mode: $invoke_mode (direct|worktree|simple)" >&2
      exit 1
      ;;
  esac

  test -s "$out" || { echo "Missing output: $out" >&2; exit 1; }
  "$FW" step --workflow "$WORKFLOW_ID" --step "$step" --agent "$pack" \
    --label "$label" --status done --summary "Step $step complete" --artifact "$out"
}

mkdir -p "$ROOT/.agent-hippo/fleet-workflows" "$ROOT/data/my-pipeline"

echo "== $WORKFLOW_ID / Live Fleet 4 =="

"$FW" init --workflow "$WORKFLOW_ID" --title "$TITLE" \
  --subtitle "$SUBTITLE" --orchestrator "$ORCHESTRATOR"
"$FW" orchestrator --workflow "$WORKFLOW_ID" --status in_progress \
  --summary "Starting $SUBTITLE"

# --- Step 1: Contention? none → direct (6th arg optional, default direct) ---
run_worker 1 "pack-a" "First task" \
  "Write output only to data/my-pipeline/step-1-output.txt. YOUR TASK HERE." \
  "data/my-pipeline/step-1-output.txt" \
  direct

# --- Step 2: same-file race → worktree ---
# run_worker 2 "pack-b" "Shared file edit" \
#   "Edit only src/shared.ts. ..." \
#   "src/shared.ts" \
#   worktree

"$FW" finish --workflow "$WORKFLOW_ID" --summary "Pipeline complete for $SUBTITLE"

echo "Phase 4 e2e complete. Optional: start-live-fleet-4.sh and re-run to monitor in Spotlight."
