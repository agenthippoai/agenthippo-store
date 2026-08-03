---
name: gws-docs
description: Read and write Google Docs.
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
      path: skills/gws-docs
    cliHelp: gws docs --help
---

# docs (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If it is missing, install `skill/gws-shared` or use the `pack/google-workspace` bundle.

```bash
gws docs <resource> <method> [flags]
```

## Helper Commands

| Command | Description |
|---------|-------------|
| [`+write`](../gws-docs-write/SKILL.md) | Append text to a document |

## API Resources

### documents

  - `batchUpdate` — Applies one or more updates to the document. Each request is validated before being applied. If any request is not valid, then the entire request will fail and nothing will be applied. Some requests have replies to give you some information about how they are applied. Other requests do not need to return information; these each return an empty reply. The order of replies matches that of the requests.
  - `create` — Creates a blank document using the title given in the request. Other fields in the request, including any provided content, are ignored. Returns the created document.
  - `get` — Gets the latest version of the specified document.

## Discovering Commands

Before calling any API method, inspect it:

```bash
# Browse resources and methods
gws docs --help

# Inspect a method's required params, types, and defaults
gws schema docs.<resource>.<method>
```

Use `gws schema` output to build your `--params` and `--json` flags.
