---
name: gws-sheets-read
description: "Google Sheets: Read values from a spreadsheet."
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
      path: skills/gws-sheets-read
    cliHelp: gws sheets +read --help
---

# sheets +read

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If it is missing, install `skill/gws-shared` or use the `pack/google-workspace` bundle.

Read values from a spreadsheet

## Usage

```bash
gws sheets +read --spreadsheet <ID> --range <RANGE>
```

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--spreadsheet` | ✓ | — | Spreadsheet ID |
| `--range` | ✓ | — | Range to read (e.g. 'Sheet1!A1:B2') |

## Examples

```bash
gws sheets +read --spreadsheet ID --range "Sheet1!A1:D10"
gws sheets +read --spreadsheet ID --range Sheet1
```

## Tips

- Read-only — never modifies the spreadsheet.
- For advanced options, use the raw values.get API.

## See Also

- [gws-shared](../gws-shared/SKILL.md) — Global flags and auth
- [gws-sheets](../gws-sheets/SKILL.md) — All read and write spreadsheets commands
