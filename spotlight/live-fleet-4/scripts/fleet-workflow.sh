#!/usr/bin/env bash
# Write Live Fleet workflow status JSON under .agent-hippo/fleet-workflows/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HIPPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
WF_DIR="${AGENT_HIPPO_FLEET_DIR:-$AGENT_HIPPO_ROOT/fleet-workflows}"
HISTORY_DIR="$WF_DIR/history"
mkdir -p "$WF_DIR" "$HISTORY_DIR"

usage() {
  cat <<'EOF'
Usage:
  fleet-workflow.sh init --workflow ID --title TITLE [--subtitle TEXT] [--orchestrator AGENT]
  fleet-workflow.sh orchestrator --workflow ID --status STATUS [--summary TEXT]
  fleet-workflow.sh step --workflow ID --step N --agent PACK --label LABEL --status STATUS
      [--summary TEXT] [--artifact ABS_PATH]
  fleet-workflow.sh finish --workflow ID [--summary TEXT]
EOF
  exit 1
}

[[ $# -ge 1 ]] || usage
CMD="$1"
shift

python3 - "$CMD" "$WF_DIR" "$HISTORY_DIR" "$@" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

STEP_COLORS = ["#fbbf24", "#38bdf8", "#a78bfa", "#34d399", "#f472b6"]

cmd = sys.argv[1]
wf_dir = Path(sys.argv[2])
history_dir = Path(sys.argv[3])
args = sys.argv[4:]


def now_z() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def parse_flags(argv: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok.startswith("--"):
            key = tok[2:].replace("-", "_")
            if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
                out[key] = "true"
                i += 1
            else:
                out[key] = argv[i + 1]
                i += 2
        else:
            i += 1
    return out


def load_workflow(workflow_id: str) -> tuple[Path, dict]:
    path = wf_dir / f"{workflow_id}.json"
    if not path.exists():
        raise SystemExit(f"Workflow not found: {path}")
    data = json.loads(path.read_text())
    return path, data


def save_workflow(path: Path, data: dict) -> None:
    data["updatedAt"] = now_z()
    path.write_text(json.dumps(data, indent=2) + "\n")


def archive_active(workflow_id: str, data: dict) -> None:
    rid = data.get("runId") or run_id()
    data["kind"] = "history"
    data["status"] = "done"
    data["finishedAt"] = data.get("finishedAt") or now_z()
    data["archivedAt"] = now_z()
    dest = history_dir / f"{workflow_id}-{rid}.json"
    data["artifact"] = str(dest.resolve())
    dest.write_text(json.dumps(data, indent=2) + "\n")
    active = wf_dir / f"{workflow_id}.json"
    if active.exists():
        active.unlink()


f = parse_flags(args)

if cmd == "init":
    workflow_id = f.get("workflow")
    title = f.get("title")
    if not workflow_id or not title:
        raise SystemExit("init requires --workflow and --title")
    active = wf_dir / f"{workflow_id}.json"
    if active.exists():
        old = json.loads(active.read_text())
        if old.get("status") == "done":
            archive_active(workflow_id, old)
        else:
            old["status"] = "done"
            old["finishedAt"] = now_z()
            archive_active(workflow_id, old)
    rid = run_id()
    ts = now_z()
    orchestrator = f.get("orchestrator", "coordinator")
    data = {
        "workflowId": workflow_id,
        "runId": rid,
        "title": title,
        "subtitle": f.get("subtitle", ""),
        "status": "in_progress",
        "kind": "active",
        "startedAt": ts,
        "updatedAt": ts,
        "finishedAt": "",
        "orchestrator": {
            "agent": orchestrator,
            "label": orchestrator.replace("-", " ").title(),
            "status": "in_progress",
            "summary": "Starting",
        },
        "steps": [],
    }
    active.write_text(json.dumps(data, indent=2) + "\n")
    print(rid)

elif cmd == "orchestrator":
    workflow_id = f.get("workflow")
    status = f.get("status")
    if not workflow_id or not status:
        raise SystemExit("orchestrator requires --workflow and --status")
    path, data = load_workflow(workflow_id)
    data.setdefault("orchestrator", {})["status"] = status
    if f.get("summary"):
        data["orchestrator"]["summary"] = f["summary"]
    save_workflow(path, data)

elif cmd == "step":
    workflow_id = f.get("workflow")
    step_s = f.get("step")
    agent = f.get("agent")
    label = f.get("label")
    status = f.get("status")
    if not all([workflow_id, step_s, agent, label, status]):
        raise SystemExit("step requires --workflow --step --agent --label --status")
    step_n = int(step_s)
    path, data = load_workflow(workflow_id)
    steps = data.setdefault("steps", [])
    entry = next((s for s in steps if s.get("step") == step_n), None)
    if entry is None:
        color = STEP_COLORS[(step_n - 1) % len(STEP_COLORS)]
        entry = {
            "step": step_n,
            "role": "worker",
            "agent": agent,
            "label": label,
            "status": "pending",
            "summary": "",
            "startedAt": "",
            "finishedAt": "",
            "artifact": "",
            "color": color,
        }
        steps.append(entry)
        steps.sort(key=lambda s: s["step"])
    entry["agent"] = agent
    entry["label"] = label
    entry["status"] = status
    if f.get("summary"):
        entry["summary"] = f["summary"]
    if f.get("artifact"):
        entry["artifact"] = f["artifact"]
    ts = now_z()
    if status == "in_progress" and not entry.get("startedAt"):
        entry["startedAt"] = ts
    if status in ("done", "failed"):
        entry["finishedAt"] = ts
    data["orchestrator"]["summary"] = f"Running: {label}" if status == "in_progress" else data["orchestrator"].get("summary", "")
    save_workflow(path, data)

elif cmd == "finish":
    workflow_id = f.get("workflow")
    if not workflow_id:
        raise SystemExit("finish requires --workflow")
    path, data = load_workflow(workflow_id)
    data["status"] = "done"
    data["finishedAt"] = now_z()
    data["orchestrator"]["status"] = "done"
    if f.get("summary"):
        data["orchestrator"]["summary"] = f["summary"]
    save_workflow(path, data)
    archive_active(workflow_id, data)

else:
    raise SystemExit(f"Unknown command: {cmd}")
PY
