# Publishing cost-guard-demo (standard Agent Pack store workflow)

This matches how every pack in [agenthippo-store](https://github.com/agenthippoai/agenthippo-store) is versioned — same model AgentIDE uses on install.

## How versioning works

| Layer | Mechanism |
|-------|-----------|
| **Store repo** | Flat `agent-packs/cost-guard-demo/` — one tree per commit |
| **Release identity** | Git tag `agent-packs/cost-guard-demo/v{semver}` |
| **Install (IDE)** | `store://agent-packs/cost-guard-demo@1.0.0` → tarball at that tag → flat pack files |
| **Local after install** | `~/.agenthippo/agents/cost-guard-demo/1.0.0/` + `current.txt` (created by installer, not in store) |

There is **no** `versions/` subfolder in the store. Subfolders like `1.0.0/` only appear on disk **after** the IDE installs multiple releases locally.

## Ship a new version (step by step)

### 1. Edit the pack at repo root

```bash
cd agent-packs/cost-guard-demo
# bump metadata.version in agent.yaml
# edit AGENTS.md, www/, etc.
```

### 2. Open PR → merge to `main`

Same fork-and-PR flow as any store artifact ([store design](https://github.com/agenthippoai/agenthippo-vscode/blob/main/PLAN/store.md)).

### 3. Tag the merge commit

```bash
git tag agent-packs/cost-guard-demo/v1.1.0
git push origin agent-packs/cost-guard-demo/v1.1.0
```

The tag name **is** the version pointer. Each tag must point at a commit where the **root** of this folder contains that version's files.

### 4. Verify install

In AgentIDE: install `store://agent-packs/cost-guard-demo@1.1.0` and confirm `agent.yaml` shows `version: 1.1.0`.

## One-time bootstrap (two tags from demo vendored files)

If `v1.0.0` and `v1.1.0` tags do not exist yet, run from **agenthippo-store** repo root:

```bash
../agenthippo-deploy-samples/pack-version-rollback/scripts/bootstrap-store-tags.sh
```

That script (maintainer-only):

1. Writes flat **1.0.0** files → commit → tag `agent-packs/cost-guard-demo/v1.0.0`
2. Writes flat **1.1.0** files → commit → tag `agent-packs/cost-guard-demo/v1.1.0`
3. Leaves `main` on 1.1.0

Source files come from the deploy sample's offline mirror (`store-pack/versions/`), not from a non-standard store layout.

## Rollback in production (deploy sample)

Deploy operators do not checkout old folders — they fetch by tag:

```bash
PACK_VERSION=1.0.0 ./deploy.sh   # fetch tag → build :1.0.0 image → deploy
./rollback.sh 1.0.0              # redeploy previous tag
```

See [`pack-version-rollback`](https://github.com/agenthippoai/agenthippo-deploy-samples/tree/main/pack-version-rollback).
