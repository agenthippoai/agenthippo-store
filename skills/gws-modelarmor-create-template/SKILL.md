---
name: gws-modelarmor-create-template
description: "Google Model Armor: Create a new Model Armor template."
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
      path: skills/gws-modelarmor-create-template
    cliHelp: gws modelarmor +create-template --help
---

# modelarmor +create-template

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If it is missing, install `skill/gws-shared` or use the `pack/google-workspace` bundle.

Create a new Model Armor template

## Usage

```bash
gws modelarmor +create-template --project <PROJECT> --location <LOCATION> --template-id <ID>
```

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--project` | ✓ | — | GCP project ID |
| `--location` | ✓ | — | GCP location (e.g. us-central1) |
| `--template-id` | ✓ | — | Template ID to create |
| `--preset` | — | — | Use a preset template: jailbreak |
| `--json` | — | — | JSON body for the template configuration (overrides --preset) |

## Examples

```bash
gws modelarmor +create-template --project P --location us-central1 --template-id my-tmpl --preset jailbreak
gws modelarmor +create-template --project P --location us-central1 --template-id my-tmpl --json '{...}'
```

## Tips

- Defaults to the jailbreak preset if neither --preset nor --json is given.
- Use the resulting template name with +sanitize-prompt and +sanitize-response.

> [!CAUTION]
> This is a **write** command — confirm with the user before executing.

## See Also

- [gws-shared](../gws-shared/SKILL.md) — Global flags and auth
- [gws-modelarmor](../gws-modelarmor/SKILL.md) — All filter user-generated content for safety commands
