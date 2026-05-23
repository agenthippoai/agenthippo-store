# Live Fleet 2 (third-party Spotlight view)

Tier-1 live fleet: filesystem-only discovery (no extension changes).

## Scripts

| Script | Role |
|--------|------|
| `live-fleet-2-collector.cjs` | Scan → `exports/live-fleet-2.json` + `charts/live-fleet-2.html` |
| `live-fleet-2-daemon.mjs` | Background watcher + 3s poll |
| `live-fleet-2-widget.cjs` | Runs collector, renders `charts/live-fleet-2.html` |

## Data sources

1. `~/.agent-hippo/analytics/sessions/*.jsonl` — `turn_start` / `turn_end` status
2. `<workspace>/.agent-hippo/sessions/<id>/context.md` — prompts (`**User:**` blocks)
3. `ps` — `agenthippo chat|ask|serve` and custom-engine runners

## Quick start

```bash
# Terminal 1 — background updates
node .agent-hippo/analytics/views/live-fleet-2/scripts/live-fleet-2-daemon.mjs

In Spotlight, open view **Live Fleet 2** and click **Refresh** (or rely on auto-run when `charts/` is empty).

The collector also renders HTML so a CLI-only run updates the gallery:

```bash
node .agent-hippo/analytics/views/live-fleet-2/scripts/live-fleet-2-collector.cjs
```

In the IDE, **Refresh** runs `live-fleet-2-widget.cjs` (requires `.cjs` in Spotlight script discovery — fixed in AgentIDE `artifactManager`).

## Environment

| Variable | Purpose |
|----------|---------|
| `LIVE_FLEET_EXPORT_DIR` | Snapshot output (default: `views/live-fleet-2/exports`) |
| `LIVE_FLEET_WORKSPACES` | Comma-separated workspace roots to scan |
| `AGENTIDE_WORKSPACE_ROOT` | Set automatically when widget runs in IDE |
| `AGENTHIPPO_HOME` | Override `~/.agent-hippo` |

## Register view

Ensure `panel/views.yaml` includes:

```yaml
- id: live-fleet-2
  name: Live Fleet 2
  scope: workspace
  scripts:
    - live-fleet-2-widget.cjs
```
