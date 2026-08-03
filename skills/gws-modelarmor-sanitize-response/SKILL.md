---
name: gws-modelarmor-sanitize-response
description: "Google Model Armor: Sanitize a model response through a Model Armor template."
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
      path: skills/gws-modelarmor-sanitize-response
    cliHelp: gws modelarmor +sanitize-response --help
---

# modelarmor +sanitize-response

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If it is missing, install `skill/gws-shared` or use the `pack/google-workspace` bundle.

Sanitize a model response through a Model Armor template

## Usage

```bash
gws modelarmor +sanitize-response --template <NAME>
```

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--template` | ✓ | — | Full template resource name (projects/PROJECT/locations/LOCATION/templates/TEMPLATE) |
| `--text` | — | — | Text content to sanitize |
| `--json` | — | — | Full JSON request body (overrides --text) |

## Examples

```bash
gws modelarmor +sanitize-response --template projects/P/locations/L/templates/T --text 'model output'
model_cmd | gws modelarmor +sanitize-response --template ...
```

## Tips

- Use for outbound safety (model -> user).
- For inbound safety (user -> model), use +sanitize-prompt.

## See Also

- [gws-shared](../gws-shared/SKILL.md) — Global flags and auth
- [gws-modelarmor](../gws-modelarmor/SKILL.md) — All filter user-generated content for safety commands
