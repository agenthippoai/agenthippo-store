# agenthippo-store

Public store of **Agent Packs**, skills, MCP servers and engines for
[AgentHippo](https://agenthippo.ai).

An Agent Pack is a versioned, deployable unit of agent — its prompt, tools, engine and
permissions. See the [Agent Pack specification](https://packs.agenthippo.ai/spec/v1/).

| | |
|---|---|
| Browse | <https://agenthippo.ai/store> |
| Search index | <https://agenthippoai.github.io/agenthippo-store/store-index.json> |
| Install | `agenthippo store install <specifier>` |

## Pack signing

Every pack in `agent-packs/` ships a `pack.sig` — an ES256 JWT binding the pack's name,
version and a digest of its contents to a signing key. A runtime configured to require
signatures refuses to load a pack whose contents no longer match its signature, which is what
stops a modified system prompt or tool policy from being executed.

### Trust root

```bash
AGENTHIPPO_PACK_JWKS_URL="https://packs.agenthippo.ai/.well-known/jwks.json?purpose=pack-signing"
AGENTHIPPO_PACK_JWKS_PINS="S9FC_5c2n3eZEAD1bQ_46jn24OADyXq0kITicUEUpgs"
```

- **kid** `store-release-2026-08` · ES256 (P-256)
- **Pin (RFC 7638 thumbprint)** `S9FC_5c2n3eZEAD1bQ_46jn24OADyXq0kITicUEUpgs`

**Set the pin.** Without it the trust root is whatever that URL serves today — so anyone who
can change what is published there decides which code your fleet will run. With it, a
compromised or mistaken publication cannot introduce a key you did not choose.

The pin is deliberately published **here as well as in the JWKS**, on different
infrastructure (GitHub vs. the Cloudflare-hosted site). A pin read from the same document it
is meant to pin is decorative. Check that the two agree before trusting either; if they ever
disagree, stop and report it rather than picking one.

It is also recorded on the
[`pack-signing/store-release-2026-08`](https://github.com/agenthippoai/agenthippo-store/releases/tag/pack-signing%2Fstore-release-2026-08)
release.

### Verifying a pack

Verification needs only the public key, so anyone can do it:

```bash
agenthippo pack verify ./agent-packs/joker1 \
  --jwks "https://packs.agenthippo.ai/.well-known/jwks.json?purpose=pack-signing"
```

A pack whose contents changed after signing fails with
`INVALID: pack contents changed after signing`.

> **Note:** the `agenthippo pack` CLI currently ships inside the AgentHippo runtime image.
> A standalone public verifier is tracked in
> [agenthippo-vscode#6](https://github.com/agenthippoai/agenthippo-vscode/issues/6); until it
> lands, verification requires that runtime.

### How signatures are produced

Packs are signed by the **Sign Pack** workflow on manual dispatch only — never automatically
on push. A signature regenerated on every content change would track `HEAD`, which git already
does, and would attest nothing. Dispatching is the moment a human asserts "this content is a
release". The **Verify Pack Signatures** workflow then re-checks every signed pack on each
push, so a later edit that is not re-signed fails visibly instead of silently shipping.

### Key rotation

New keys are **appended** to the JWKS, never swapped in place, so consumers pinned to the
previous key keep working during the overlap. Both pins are published while a rotation is in
progress; the old key is dropped only once nothing pins it. Rotations are announced in this
README and as a release.
