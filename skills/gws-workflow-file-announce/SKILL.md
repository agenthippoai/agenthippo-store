---
name: gws-workflow-file-announce
description: "Google Workflow: Announce a Drive file in a Chat space."
version: 0.22.5
author: Google Workspace
homepage: https://github.com/googleworkspace/cli
tags:
  - google-workspace
  - gws
metadata:
  version: 0.22.5
  agenthippo:
    requires:
      bins:
        - gws
    install:
      - id: npm
        kind: npm
        package: "@googleworkspace/cli"
        bins:
          - gws
        label: Install Google Workspace CLI (npm)
    source:
      repository: https://github.com/googleworkspace/cli
      path: skills/gws-workflow-file-announce
    cliHelp: gws workflow +file-announce --help
---

# workflow +file-announce

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If it is missing, install `skill/gws-shared` or use the `pack/google-workspace` bundle.

Announce a Drive file in a Chat space

## Usage

```bash
gws workflow +file-announce --file-id <ID> --space <SPACE>
```

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--file-id` | ✓ | — | Drive file ID to announce |
| `--space` | ✓ | — | Chat space name (e.g. spaces/SPACE_ID) |
| `--message` | — | — | Custom announcement message |
| `--format` | — | — | Output format: json (default), table, yaml, csv |

## Examples

```bash
gws workflow +file-announce --file-id FILE_ID --space spaces/ABC123
gws workflow +file-announce --file-id FILE_ID --space spaces/ABC123 --message 'Check this out!'
```

## Tips

- This is a write command — sends a Chat message.
- Use `gws drive +upload` first to upload the file, then announce it here.
- Fetches the file name from Drive to build the announcement.

## See Also

- [gws-shared](../gws-shared/SKILL.md) — Global flags and auth
- [gws-workflow](../gws-workflow/SKILL.md) — All cross-service productivity workflows commands
