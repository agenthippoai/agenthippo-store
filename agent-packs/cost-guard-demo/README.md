# cost-guard-demo

Demo Agent Pack for **versioned deploy + rollback** pitches.

- **Install (IDE):** `store://agent-packs/cost-guard-demo@1.0.0` or `@1.1.0`
- **Deploy sample:** [`pack-version-rollback`](https://github.com/agenthippoai/agenthippo-deploy-samples/tree/main/pack-version-rollback)

## Layout (standard store)

Same as every other pack in this repo — **flat files at the pack root**. Version is in `agent.yaml` metadata and in **git tags**, not subfolders:

```
agent-packs/cost-guard-demo/
├── README.md
├── RELEASE.md          # how to publish a new version
├── agent.yaml          # metadata.version matches this release
├── AGENTS.md
└── www/
```

**`main`** tracks the latest release (currently **1.1.0**).

## Versions

| Tag | Behavior |
|-----|----------|
| `agent-packs/cost-guard-demo/v1.0.0` | Concise support analyst (2–4 sentences) |
| `agent-packs/cost-guard-demo/v1.1.0` | Verbose 4-paragraph structure (cost regression demo) |

See [RELEASE.md](./RELEASE.md) for the maintainer workflow.
