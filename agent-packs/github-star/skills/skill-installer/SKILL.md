---
name: skill-installer
description: Guide for discovering and installing skills, agent packs, and MCP servers from the registry. Use when users ask to find, search, browse, or install skills, agent packs, MCPs, or agent configurations.
---

# Skill Installer

Install skills, agent packs, and MCP servers using CLI commands.

Use this invocation form for maximum compatibility in IDE sessions:

```bash
"${AGENTHIPPO_CLI_PATH:-agenthippo}" <command>
```

When running in Agent Hippo IDE, `AGENTHIPPO_CLI_PATH` may be injected automatically. Always keep the `:-agenthippo` fallback for portability.

Before running store commands, perform a quick preflight:

```bash
"${AGENTHIPPO_CLI_PATH:-agenthippo}" --version
```

If preflight fails, tell the user to run **Agent Hippo: Setup AgentHippo CLI**.

Use `--workspace "$AGENTHIPPO_WORKSPACE_ROOT"` and `--agent "${AGENTHIPPO_ACTIVE_AGENT:-default}"` when available.


## Quick Reference

```bash
# Search
agenthippo store search <query>
agenthippo store search "pdf" --type skill
agenthippo store list --type pack

# Install (use folder-based paths: skills/, agent-packs/, mcp/)
agenthippo store install skills/pdf-tools
agenthippo store install agent-packs/code-reviewer@1.0.0
agenthippo store install mcp/filesystem --agent default

# Info
agenthippo store info skills/pdf-tools --json
```

## Workflow

1. **Search** for the artifact
2. **Inspect** metadata (author, version, description)
3. **Download & scan** for security issues
4. **Report** findings to user
5. **Install** if scan passes

## Search

```bash
# Search all types
agenthippo store search "document editing"

# Filter by type
agenthippo store search "code review" --type pack
agenthippo store search "pdf" --type skill --limit 10

# List all available
agenthippo store list
agenthippo store list --type skill

# JSON output for parsing
agenthippo store search "pdf" --json
```

**Output format:**
```
Found 3 result(s):

  📦 skill/pdf-tools  v1.2.0 ✓
     PDF editing, form filling, and text extraction
     Installed to: default, code-reviewer

  ☁️  skill/docx  v2.0.1
     Word document creation and editing

  ☁️  skill/canvas-design  v1.0.0
     Canvas design skill

Legend: 📦 Local  ☁️ Remote  ✓ Installed

Install with:
  agenthippo store install <type>/<slug>
```

**Icons:**
- 📦 = Installed locally (in your library)
- ☁️ = Available from remote store (not yet installed)
- ✓ = Installed checkmark

## Inspect

```bash
# Show details
agenthippo store info skills/pdf-tools

# JSON for parsing
agenthippo store info agent-packs/code-reviewer --json
```

## Security Scan (MANDATORY)

Before installing, scan downloaded files for dangerous patterns.

### High Severity (Recommend BLOCK)

| Pattern | Risk |
|---------|------|
| `eval(`, `new Function(` | Code injection |
| `child_process.exec`, `os.system` | Shell injection |
| `pickle.loads` | Arbitrary code execution |
| Hardcoded API keys/tokens | Credential leak |
| File writes outside workspace | System compromise |

### Medium Severity (Warn User)

| Pattern | Risk |
|---------|------|
| `innerHTML =`, `document.write` | XSS |
| `subprocess` with `shell=True` | Injection risk |
| Minified/obfuscated code | Hidden behavior |
| Broad `allowed-tools` in frontmatter | Over-privileged |
| Network calls to unknown hosts | Data exfiltration |


### Report Format

```
⚠️ Security Scan: skill/example-tool

HIGH: scripts/run.py:42 — eval() — code injection risk
MED: SKILL.md — allowed-tools: Bash(*) — unrestricted shell

Recommendation: BLOCK

Proceed anyway? [y/N]
```

If **high severity** issues exist → recommend **BLOCK**.
If **medium only** → warn and ask for confirmation.

## Install

```bash
# Install skill to current workspace
agenthippo store install skills/pdf-tools

# Install specific version
agenthippo store install skills/pdf-tools@1.2.0

# Install to specific agent
agenthippo store install skills/pdf-tools --agent my-agent

# Install agent pack (goes to user library)
agenthippo store install agent-packs/code-reviewer

# Install MCP server
agenthippo store install mcp/filesystem

# Force overwrite existing
agenthippo store install skills/pdf-tools --force

# Specify workspace
agenthippo store install skills/pdf-tools --workspace /path/to/project
```

### Installation Paths

| Type | Path |
|------|------|
| Skill | `<workspace>/.{{BRAND_FOLDER}}/agents/<agentId>/skills/<slug>/` |
| Pack | `~/.{{BRAND_FOLDER}}/agents/<slug>/<version>/` |
| MCP | `<workspace>/.{{BRAND_FOLDER}}/agents/<agentId>/mcp/<slug>/` |

## Verify Installation

After install, verify:

1. **Files exist** at expected path
2. **SKILL.md** (or `agent.yaml` for packs) is valid

```bash
# Verify pack
agenthippo pack info <slug>
agenthippo pack validate <slug>

# List installed packs
agenthippo pack list
```

## Custom Store

To use a different store repository:

```bash
# Set custom store repo (default: agenthippoai/agenthippo-store)
export AGENTHIPPO_STORE_REPO=myorg/my-store

# Or set direct index URL
export AGENTHIPPO_STORE_URL=https://myorg.github.io/my-store/store-index.json
```

## Private Repos

For private store repositories, set a GitHub token:

```bash
# Any of these work:
export GITHUB_TOKEN=ghp_...
export GH_TOKEN=ghp_...
export AGENTHIPPO_GITHUB_TOKEN=ghp_...

# Then run commands as usual
agenthippo store search "my internal skill"
agenthippo store install skills/internal-tool
```

The CLI tries GitHub Pages first (public), then falls back to GitHub API with auth for private repos.

## Fallback: Manual Download

If CLI is unavailable, use curl:

```bash
# Download artifact tarball
curl -L "https://api.github.com/repos/agenthippoai/agenthippo-store/tarball/skills/pdf-tools/v1.0.0" \
  -H "Accept: application/vnd.github.v3+json" \
  -o artifact.tar.gz

# Extract
tar -xzf artifact.tar.gz
# Files are in: <extracted>/skills/pdf-tools/
```

## Local Library Paths

Already-installed artifacts:

- **Workspace skills:** `<workspace>/.{{BRAND_FOLDER}}/agents/<agentId>/skills/`
- **User packs:** `~/.{{BRAND_FOLDER}}/agents/`
- **Manifest:** `<workspace>/.{{BRAND_FOLDER}}/agentide.manifest.json`

## Reference

For programmatic API details, see [references/store-api.md](references/store-api.md).
