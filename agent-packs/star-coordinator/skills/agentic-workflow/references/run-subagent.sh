#!/usr/bin/env bash
# Invoke a worker agent pack with the workspace policy from agentic-workflow skill:
#   direct   — same workspace (default); disjoint file paths, no write races
#   worktree — git worktree when sub-tasks may race on the same files
#   simple   — ephemeral dir; stdout-only, no workspace artifact writes
#
# Usage:
#   run-subagent.sh direct   --orig "$ORIG" --agent PACK -- <prompt...>
#   run-subagent.sh worktree --orig "$ORIG" --agent PACK -- <prompt...>
#   run-subagent.sh simple   --orig "$ORIG" --agent PACK -- <prompt...>
#
# Extra args before "--" are forwarded to agenthippo ask (e.g. --engine cursor --model auto).
set -euo pipefail

MODE="${1:-}"
shift || true

ORIG=""
AGENT=""
ENGINE="${AGENTHIPPO_ENGINE:-cursor}"
MODEL="${AGENTHIPPO_MODEL:-auto}"
WORKFLOW_ID="${AGENTHIPPO_WORKFLOW_ID:-subagent}"
STEP="${AGENTHIPPO_STEP:-0}"
FORWARD=()
PROMPT_PARTS=()

usage() {
  cat <<'EOF'
Usage:
  run-subagent.sh direct   --orig <abs-path> --agent <pack> [--engine E] [--model M] -- <prompt...>
  run-subagent.sh worktree --orig <abs-path> --agent <pack> [--engine E] [--model M] [--workflow-id ID] [--step N] -- <prompt...>
  run-subagent.sh simple   --orig <abs-path> --agent <pack> [--engine E] [--model M] -- <prompt...>

Modes:
  direct    Default. --workspace <orig>. Use when workers touch different files (no write race).
  worktree  Isolated checkout when sub-tasks may edit the same paths (parallel or overlapping writes).
  simple    Temp workspace + ORIG_WORKSPACE in prompt. Stdout-only; no data/ artifact writes.
EOF
}

die() { echo "run-subagent.sh: $*" >&2; exit 1; }

abs_path() {
  python3 -c "import os,sys; print(os.path.abspath(sys.argv[1]))" "$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --orig) ORIG="${2:-}"; shift 2 ;;
    --agent) AGENT="${2:-}"; shift 2 ;;
    --engine) ENGINE="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --workflow-id) WORKFLOW_ID="${2:-}"; shift 2 ;;
    --step) STEP="${2:-}"; shift 2 ;;
    --) shift; PROMPT_PARTS=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) FORWARD+=("$1"); shift ;;
  esac
done

[[ -n "$MODE" ]] || { usage; die "mode required (direct|worktree|simple)"; }
[[ "$MODE" == "direct" || "$MODE" == "worktree" || "$MODE" == "simple" ]] || die "mode must be direct, worktree, or simple"
[[ -n "$ORIG" ]] || die "--orig required"
[[ -n "$AGENT" ]] || die "--agent required"
[[ ${#PROMPT_PARTS[@]} -gt 0 ]] || die "prompt required after --"

ORIG="$(abs_path "$ORIG")"
[[ -d "$ORIG" ]] || die "orig workspace not found: $ORIG"

PROMPT="${PROMPT_PARTS[*]}"
ASK=(agenthippo ask --engine "$ENGINE" --model "$MODEL")

link_shared_artifacts() {
  local target_root="$1"
  mkdir -p "$target_root/.agent-hippo"
  for rel in data .agent-hippo/agents .agent-hippo/fleet-workflows .agent-hippo/analytics; do
    if [[ -e "$ORIG/$rel" && ! -e "$target_root/$rel" ]]; then
      mkdir -p "$(dirname "$target_root/$rel")"
      ln -sfn "$ORIG/$rel" "$target_root/$rel"
    fi
  done
}

run_direct() {
  set +e
  "${ASK[@]}" --workspace "$ORIG" --agent "$AGENT" "${FORWARD[@]}" "$PROMPT"
  local rc=$?
  set -e
  return "$rc"
}

run_worktree() {
  command -v git >/dev/null 2>&1 || die "git required for worktree mode"
  git -C "$ORIG" rev-parse --git-dir >/dev/null 2>&1 || die "orig is not a git repo: $ORIG"

  local wt_root branch ts
  ts="$(date +%s)"
  wt_root="${TMPDIR:-/tmp}/agenthippo-wt-${WORKFLOW_ID}-step-${STEP}-${ts}-$$"
  branch="agenthippo/${WORKFLOW_ID}/step-${STEP}-${ts}"

  git -C "$ORIG" worktree add -b "$branch" "$wt_root" HEAD
  link_shared_artifacts "$wt_root"

  local wrapped
  wrapped="ORIG_WORKSPACE=${ORIG}. Shared artifacts under ORIG_WORKSPACE (e.g. data/). ${PROMPT}"

  set +e
  "${ASK[@]}" --workspace "$wt_root" --agent "$AGENT" "${FORWARD[@]}" "$wrapped"
  local rc=$?
  set -e

  git -C "$ORIG" worktree remove --force "$wt_root" 2>/dev/null || rm -rf "$wt_root"
  git -C "$ORIG" branch -D "$branch" 2>/dev/null || true
  return "$rc"
}

run_simple() {
  local run_dir wrapped
  run_dir="$(mktemp -d "${TMPDIR:-/tmp}/agenthippo-run.XXXXXX")"
  wrapped="ORIG_WORKSPACE=${ORIG}. Use absolute paths under ORIG_WORKSPACE for reads. Output to stdout only unless explicitly told otherwise. ${PROMPT}"

  set +e
  "${ASK[@]}" --workspace "$run_dir" --agent "$AGENT" "${FORWARD[@]}" "$wrapped"
  local rc=$?
  set -e

  rm -rf "$run_dir"
  return "$rc"
}

case "$MODE" in
  direct) run_direct ;;
  worktree) run_worktree ;;
  simple) run_simple ;;
esac
