# Fleet workflow JSON schema

Files written by `.agent-hippo/scripts/fleet-workflow.sh`.

## Active run

Path: `.agent-hippo/fleet-workflows/<workflowId>.json`

```json
{
  "workflowId": "star-pipeline",
  "runId": "20260530-214649",
  "title": "GitHub Star Pipeline",
  "subtitle": "vercel/next.js",
  "status": "in_progress",
  "kind": "active",
  "startedAt": "2026-05-30T21:46:49Z",
  "updatedAt": "2026-05-30T21:47:23Z",
  "finishedAt": "",
  "orchestrator": {
    "agent": "star-coordinator",
    "label": "Star Coordinator",
    "status": "in_progress",
    "summary": "Running: Collect 7-day stars"
  },
  "steps": [
    {
      "step": 1,
      "role": "worker",
      "agent": "joker1",
      "label": "Warm-up joke",
      "status": "done",
      "summary": "One-line joke",
      "startedAt": "2026-05-30T21:46:08Z",
      "finishedAt": "2026-05-30T21:47:03Z",
      "artifact": "/abs/path/data/fleet-live/step-1-joker1.txt",
      "color": "#fbbf24"
    },
    {
      "step": 2,
      "role": "worker",
      "agent": "github-star",
      "label": "Collect 7-day stars",
      "status": "in_progress",
      "summary": "",
      "startedAt": "2026-05-30T21:46:24Z",
      "finishedAt": "",
      "artifact": "",
      "color": "#38bdf8"
    }
  ]
}
```

## Archived run (Finished lane)

Path: `.agent-hippo/fleet-workflows/history/<workflowId>-<runId>.json`

Same shape plus:

```json
{
  "kind": "history",
  "status": "done",
  "finishedAt": "2026-05-30T21:47:38Z",
  "archivedAt": "2026-05-30T21:47:38Z",
  "artifact": "/abs/path/.agent-hippo/fleet-workflows/history/star-pipeline-20260530-214649.json"
}
```

## Step colors (default)

| Step | Color |
|------|-------|
| 1 | `#fbbf24` |
| 2 | `#38bdf8` |
| 3 | `#a78bfa` |
| 4 | `#34d399` |
| 5 | `#f472b6` |

## Live Fleet 4 export snapshot

Path: `.agent-hippo/analytics/views/live-fleet-4/exports/live-fleet-4.json`

Collector merges all workspace workflow files into:

```json
{
  "generatedAt": "2026-05-30T21:47:38Z",
  "source": "live-fleet-4",
  "totals": {
    "running": 0,
    "finished": 5,
    "history": 5,
    "stepsActive": 0
  },
  "running": [],
  "finished": [],
  "history": [ /* archived workflow objects */ ]
}
```

Widget maps `history` → **Finished** lane in the UI.

## fleet-workflow.sh commands

| Command | Effect |
|---------|--------|
| `init` | New run; archives prior `done` active file |
| `orchestrator` | Update orchestrator block |
| `step` | Upsert step; sets `startedAt` on `in_progress`, `finishedAt` on `done` |
| `finish` | Mark done, archive to `history/`, delete active file |

### step flags

```
--workflow ID
--step N
--agent PACK_ID
--label "Human label"
--status pending|in_progress|done|failed
--summary "one line"
--artifact "/absolute/path"
```
