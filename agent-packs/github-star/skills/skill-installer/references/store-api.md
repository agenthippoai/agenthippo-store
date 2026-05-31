# Store CLI Reference

The `agenthippo store` command provides search and install capabilities.

Prefer invoking the CLI with a portable fallback:

```bash
"${AGENTHIPPO_CLI_PATH:-agenthippo}" store <subcommand>
```

In Agent Hippo IDE sessions, these environment variables may be available:
- `AGENTHIPPO_CLI_PATH` — absolute path to the resolved CLI binary
- `AGENTHIPPO_WORKSPACE_ROOT` — workspace root path for `--workspace`
- `AGENTHIPPO_ACTIVE_AGENT` — active agent id for `--agent`

Preflight check:

```bash
"${AGENTHIPPO_CLI_PATH:-agenthippo}" --version
```

If unavailable, users can run **Agent Hippo: Setup AgentHippo CLI** from the command palette.

Use these flags when available:

```bash
--workspace "$AGENTHIPPO_WORKSPACE_ROOT" --agent "${AGENTHIPPO_ACTIVE_AGENT:-default}"
```

Examples below continue to show `agenthippo ...` for readability.


## Commands

### search

Search for artifacts in the store.

```bash
agenthippo store search <query> [options]
```

Options:
- `--type <type>` — Filter: `pack`, `skill`, `mcp`
- `--limit <n>` — Max results (default: 20)
- `--json` — Output as JSON

Examples:
```bash
agenthippo store search "pdf editing"
agenthippo store search "code review" --type pack
agenthippo store search "document" --limit 5 --json
```

### list

List all available artifacts.

```bash
agenthippo store list [options]
```

Options:
- `--type <type>` — Filter: `pack`, `skill`, `mcp`
- `--json` — Output as JSON

### install

Install an artifact from the store.

```bash
agenthippo store install <type/slug[@version]> [options]
```

Options:
- `--version <ver>` — Specific version (default: latest)
- `--workspace <path>` — Target workspace (default: cwd)
- `--agent <id>` — Target agent for skills/mcp (default: `default`)
- `--force` — Overwrite existing installation
- `--json` — Output as JSON

Examples:
```bash
agenthippo store install skill/pdf-tools
agenthippo store install pack/code-reviewer@1.0.0
agenthippo store install mcp/filesystem --agent my-agent
agenthippo store install skill/docx --force
```

### info

Show artifact details.

```bash
agenthippo store info <type/slug> [options]
```

Options:
- `--json` — Output as JSON (includes version list)

## Artifact Reference Format

```
<type>/<slug>[@version]
```

Examples:
- `skill/pdf-tools`
- `pack/code-reviewer@1.0.0`
- `mcp/filesystem`

Type aliases:
- `pack`, `packs`, `agent-packs` → pack
- `skill`, `skills` → skill
- `mcp` → mcp

## JSON Output Schema

### Search Result

```json
[
  {
    "id": "skill/pdf-tools",
    "type": "skill",
    "slug": "pdf-tools",
    "displayName": "PDF Tools",
    "description": "PDF editing and form filling",
    "tags": ["pdf", "forms"],
    "author": "agenthippo",
    "latestVersion": "1.2.0"
  }
]
```

### Info Result

```json
{
  "id": "skill/pdf-tools",
  "type": "skill",
  "slug": "pdf-tools",
  "displayName": "PDF Tools",
  "description": "PDF editing and form filling",
  "tags": ["pdf", "forms"],
  "author": "agenthippo",
  "latestVersion": "1.2.0",
  "versions": [
    { "version": "1.2.0", "tagName": "skills/pdf-tools/v1.2.0", "isPrerelease": false },
    { "version": "1.1.0", "tagName": "skills/pdf-tools/v1.1.0", "isPrerelease": false }
  ]
}
```

## Store Configuration

The store connects to the default repository:
- **Repo:** `agenthippoai/agenthippo-store`
- **Index:** `https://agenthippoai.github.io/agenthippo-store/store-index.json`

To use a custom store, set VS Code settings:
- `agentide.storeRepo` — GitHub repo (e.g., `myorg/my-store`)
- `agentide.store.indexUrl` — Custom index URL

## Installation Paths

| Type | Path |
|------|------|
| Skill | `<workspace>/.agent-hippo/agents/<agentId>/skills/<slug>/` |
| Pack | `~/.agent-hippo/agents/<slug>/<version>/` |
| MCP | `<workspace>/.agent-hippo/agents/<agentId>/mcp/<slug>/` |

For packs, a `current.txt` file in the pack root points to the active version.

## Exit Codes

- `0` — Success
- `1` — Error (invalid args, not found, network error)

## Environment Variables

### Store Configuration

- `AGENTHIPPO_STORE_REPO` — GitHub repo (e.g., `myorg/my-store`). Default: `agenthippoai/agenthippo-store`
- `AGENTHIPPO_STORE_URL` — Direct index URL (overrides repo-based URL)

### Authentication

- `GITHUB_TOKEN` — GitHub personal access token for private repos
- `GH_TOKEN` — Alternative token variable (GitHub CLI compatible)
- `AGENTHIPPO_GITHUB_TOKEN` — Agent Hippo specific token

### Debug

- `VERBOSE=1` — Enable verbose logging to stderr

## Custom Store

To use a different store repository:

```bash
# Point to your org's store
export AGENTHIPPO_STORE_REPO=myorg/my-private-store

# Or use a direct URL
export AGENTHIPPO_STORE_URL=https://mycdn.example.com/store-index.json
```

## Private Repo Support

For private store repositories:

1. Create a GitHub Personal Access Token with `repo` scope
2. Export it: `export GITHUB_TOKEN=ghp_...`
3. Run CLI commands as usual

The CLI automatically:
1. Tries GitHub Pages first (public repos, fast CDN)
2. Falls back to GitHub API with auth if Pages returns 403/404
