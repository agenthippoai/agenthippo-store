<!-- Generated from Agent Pack agenthippo-is-a-joke@0.1.0 — packs.agenthippo.ai -->
# Deploy: agenthippo-is-a-joke — colocated with the org IdP

No Caddy, no oauth2-proxy, no local auth-broker, no auth secrets on this host — this
agent rides the org IdP's already-running edge (`enterprise-deploy/idp/`) instead.

```bash
cp deploy/.env.example deploy/.env   # model key only — no auth secrets here at all
# Point at the IdP's colocate network if it was created under a different compose
# project name: export AGENTHIPPO_IDP_NETWORK=agenthippo-idp-colocate (the default)
docker compose -f deploy/docker-compose.yml up -d --build

# Wire the route into the IdP's Caddy (one-time per agent):
cp deploy/agent-route.caddy <idp-host>:enterprise-deploy/idp/agents/agenthippo-is-a-joke.caddy
docker compose -f enterprise-deploy/idp/docker-compose.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile
```

DNS: point `joke.agenthippo.ai` at the IdP host (same as every other agent it fronts).

**Browser:** after Google SSO, open `https://joke.agenthippo.ai/` for the static chat UI
(`deploy/www/index.html` served by the agent container at GET /).

**Egress:** this container only needs outbound access to `api.anthropic.com:443` (your
model provider) — and, if the LiteLLM gateway/Spotlight sidecar is enabled, its own
outbound is the same host. Restrict egress to this allowlist if your org requires it.
