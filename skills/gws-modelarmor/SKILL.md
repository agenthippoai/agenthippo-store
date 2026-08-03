---
name: gws-modelarmor
description: "Google Model Armor: Filter user-generated content for safety."
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
      path: skills/gws-modelarmor
    cliHelp: gws modelarmor --help
---

# modelarmor (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If it is missing, install `skill/gws-shared` or use the `pack/google-workspace` bundle.

```bash
gws modelarmor <resource> <method> [flags]
```

## Helper Commands

| Command | Description |
|---------|-------------|
| [`+sanitize-prompt`](../gws-modelarmor-sanitize-prompt/SKILL.md) | Sanitize a user prompt through a Model Armor template |
| [`+sanitize-response`](../gws-modelarmor-sanitize-response/SKILL.md) | Sanitize a model response through a Model Armor template |
| [`+create-template`](../gws-modelarmor-create-template/SKILL.md) | Create a new Model Armor template |

## Discovering Commands

Before calling any API method, inspect it:

```bash
# Browse resources and methods
gws modelarmor --help

# Inspect a method's required params, types, and defaults
gws schema modelarmor.<resource>.<method>
```

Use `gws schema` output to build your `--params` and `--json` flags.
