---
name: star-pipeline
description: Run joker1 → github-star → star-visualizer with Live Fleet 3 workflow artifacts.
---

# Star Pipeline

| Step | Agent | Human label |
|------|-------|-------------|
| 1 | joker1 | Warm-up joke |
| 2 | github-star | Collect 7-day stars |
| 3 | star-visualizer | Plot star history (purple) |

Orchestrator: **star-coordinator** (separate header in Live Fleet 3).

## Fleet artifacts

Script: `.agent-hippo/scripts/fleet-workflow.sh`  
Output: `.agent-hippo/fleet-workflows/star-pipeline.json`

```bash
FW=".agent-hippo/scripts/fleet-workflow.sh"
"$FW" init --workflow star-pipeline --title "GitHub Star Pipeline" \
  --subtitle "$REPO" --orchestrator star-coordinator
"$FW" step --workflow star-pipeline --step N --agent PACK \
  --label "Human label" --status in_progress|done [--summary "..."]
"$FW" finish --workflow star-pipeline
```

View: **Spotlight → Live Fleet 3**

## CLI steps

```bash
agenthippo ask "..." --agent joker1 --workspace .
agenthippo ask "Collect 7-day stars for $REPO" --agent github-star --workspace .
agenthippo ask "Plot with purple #a78bfa" --agent star-visualizer --workspace .
```

Final line: `Done`
