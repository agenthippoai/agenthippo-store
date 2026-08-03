---
name: gws-sheets-append
description: "Google Sheets: Append a row to a spreadsheet."
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
      path: skills/gws-sheets-append
    cliHelp: gws sheets +append --help
---

# sheets +append

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If it is missing, install `skill/gws-shared` or use the `pack/google-workspace` bundle.

Append a row to a spreadsheet

## Usage

```bash
gws sheets +append --spreadsheet <ID>
```

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--spreadsheet` | ✓ | — | Spreadsheet ID |
| `--values` | — | — | Comma-separated values (simple strings) |
| `--json-values` | — | — | JSON array of rows, e.g. '[["a","b"],["c","d"]]' |
| `--range` | — | `A1` | Target range in A1 notation (e.g. 'Sheet2!A1') to select a specific tab |

## Examples

```bash
gws sheets +append --spreadsheet ID --values 'Alice,100,true'
gws sheets +append --spreadsheet ID --json-values '[["a","b"],["c","d"]]'
gws sheets +append --spreadsheet ID --range "Sheet2!A1" --values 'Alice,100'
```

## Tips

- Use --values for simple single-row appends.
- Use --json-values for bulk multi-row inserts.
- Use --range to append to a specific sheet tab (default: A1, i.e. first sheet).

> [!CAUTION]
> This is a **write** command — confirm with the user before executing.

## See Also

- [gws-shared](../gws-shared/SKILL.md) — Global flags and auth
- [gws-sheets](../gws-sheets/SKILL.md) — All read and write spreadsheets commands
