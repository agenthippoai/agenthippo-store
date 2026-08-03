# Generated from Agent Pack agenthippo-is-a-joke@0.1.0 — packs.agenthippo.ai. Build context = pack root:
#   docker build -f deploy/Dockerfile -t agenthippo-is-a-joke:local .
FROM ghcr.io/agenthippo/runtime:latest
LABEL ai.agenthippo.pack.name="agenthippo-is-a-joke"
LABEL ai.agenthippo.pack.version="0.1.0"
LABEL ai.agenthippo.pack.engine="claude"
COPY . /app/pack/
# Skill dependencies — installed at BUILD time so skills that ship their own
# requirements.txt / package.json have their libs present at runtime
# (AGENTHIPPO_NO_AUTO_INSTALL=1 skips runtime installs). No-op when none exist.
USER root
RUN set -e; \
    py_reqs=$(find /app/pack/skills /app/pack/scripts -type f -name requirements.txt -not -path "*/node_modules/*" 2>/dev/null || true); \
    if [ -n "$py_reqs" ]; then \
      pip3 --version 2>/dev/null || (apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*); \
      echo "$py_reqs" | while IFS= read -r f; do [ -n "$f" ] && pip3 install --no-cache-dir --break-system-packages -r "$f" || true; done; \
    fi; \
    pkg_json=$(find /app/pack/skills /app/pack/scripts -type f -name package.json -not -path "*/node_modules/*" 2>/dev/null || true); \
    if [ -n "$pkg_json" ]; then \
      echo "$pkg_json" | while IFS= read -r f; do [ -n "$f" ] && (cd "$(dirname "$f")" && npm install --omit=dev --no-audit --no-fund || true) || true; done; \
    fi
USER agent
ENV AGENTHIPPO_NO_AUTO_INSTALL=1
ENV AGENTHIPPO_SERVE_HOST=0.0.0.0
EXPOSE 8080
CMD ["serve","--agent","/app/pack","--workspace","/state/workspace","--state-dir","/state","--port","8080","--model","ah-auto","--www-dir","/app/pack/deploy/www"]
