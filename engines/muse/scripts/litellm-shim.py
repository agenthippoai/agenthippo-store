#!/usr/bin/env python3
"""Muse-protocol -> LiteLLM shim. Serves /muse-code/models; logs everything else."""
import http.server, json, os, tempfile, urllib.error, urllib.request

PORT = int(os.environ.get('SHIM_PORT', '4399'))
LITELLM = os.environ.get('LITELLM_BASE', 'http://127.0.0.1:4000/v1')
LITELLM_KEY = os.environ.get('LITELLM_KEY', 'sk-dummy')
MODEL = os.environ.get('SHIM_MODEL', 'ah-auto')
def _default_log_path() -> str:
    """Per-user location. A shared /tmp path would let any local user read session ids, or
    pre-create the file as a symlink."""
    home_dir = os.path.join(os.path.expanduser('~'), '.agent-hippo')
    try:
        os.makedirs(home_dir, exist_ok=True)
        return os.path.join(home_dir, 'muse-shim.log')
    except OSError:
        return os.path.join(tempfile.gettempdir(), f'muse-shim-{os.getuid()}.log')


LOG_PATH = os.environ.get('SHIM_LOG') or _default_log_path()

# Spotlight attribution. The OTEL hook builds engine/session columns from this allowlisted header
# family; without them muse traffic lands in Spotlight as engine=(unknown), source=(unknown).
# Muse stamps its own session uuid on every request, which is also what the engine persists as
# nativeSessionId — so mapping it here correlates Spotlight traces to AgentHippo sessions.
MUSE_SESSION_HEADERS = ('x-tbh-session-id', 'x-meta-ai-gateway-session-id')
META_SOURCE = os.environ.get('SHIM_SOURCE', 'agenthippo')
META_ENGINE = os.environ.get('SHIM_ENGINE', 'muse')
META_AGENT_ID = os.environ.get('SHIM_AGENT_ID', 'muse')
META_AGENT_VERSION = os.environ.get('SHIM_AGENT_VERSION')

ENTRY = {
    "id": MODEL, "model_id": MODEL, "object": "model",
    "name": MODEL, "display_name": "AH Auto", "display_label": "AH Auto",
    "provider_id": "meta", "profile_id": "tbh",
    "visibility": "visible", "hidden": False, "status": "available", "state": "available",
    "is_current": True, "is_default": True, "default": True, "current": True,
    "roles": ["default", "chat", "agent"], "release_date": "2026-08-05", "display_order": 1,
    "context_limit": 200000, "context_window": 200000,
    "output_limit": 16384, "max_output_tokens": 16384,
    "description": "AgentHippo ah-auto via LiteLLM",
    "cost": {"input": "0", "output": "0", "cached": "0", "currency": "USD"},
    "reasoning_effort_variants": None,
    "supports_tools": True, "supports_streaming": True, "supports_reasoning": False,
    "capabilities": ["tools", "streaming"],
}
CATALOG = {
    "schema_version": 1, "object": "list", "provider_id": "meta", "profile_id": "tbh",
    "source": "provider_catalog", "default_model": MODEL,
    "data": [ENTRY], "models": [ENTRY], "rows": [ENTRY],
}

def log(msg):
    with open(LOG_PATH, 'a') as f:
        f.write(msg + '\n')

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass

    def _read(self):
        n = int(self.headers.get('content-length') or 0)
        return self.rfile.read(n) if n else b''

    def _send(self, code, body: bytes, ctype='application/json'):
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        body = self._read()
        log(f'GET {self.path} {body[:300]!r}')
        if self.path.rstrip('/').endswith('/muse-code/models'):
            self._send(200, json.dumps(CATALOG).encode()); return
        self._send(404, b'{"detail":"shim: unhandled GET"}')

    def do_POST(self):
        body = self._read()
        log(f'POST {self.path} bytes={len(body)} accept={self.headers.get("accept")}')
        target = LITELLM.rstrip('/') + '/' + self.path.lstrip('/').split('muse-code/')[-1]
        req = urllib.request.Request(target, data=body, method='POST')
        req.add_header('authorization', f'Bearer {LITELLM_KEY}')
        req.add_header('content-type', 'application/json')
        accept = self.headers.get('accept') or 'application/json'
        req.add_header('accept', accept)

        session_id = next(
            (self.headers.get(h) for h in MUSE_SESSION_HEADERS if self.headers.get(h)), None)
        req.add_header('x-litellm-metadata-source', META_SOURCE)
        req.add_header('x-litellm-metadata-engine', META_ENGINE)
        req.add_header('x-litellm-metadata-agent-id', META_AGENT_ID)
        if META_AGENT_VERSION:
            req.add_header('x-litellm-metadata-agent-version', META_AGENT_VERSION)
        if session_id:
            req.add_header('x-litellm-metadata-session-id', session_id)
        log(f'  attribution: source={META_SOURCE} engine={META_ENGINE} '
            f'agent={META_AGENT_ID} session={session_id}')
        try:
            with urllib.request.urlopen(req, timeout=600) as up:
                self.send_response(up.status)
                ctype = up.headers.get('content-type', 'application/json')
                self.send_header('content-type', ctype)
                self.send_header('cache-control', 'no-cache')
                self.send_header('connection', 'close')
                self.end_headers()
                n = 0
                while True:
                    chunk = up.read(1024)
                    if not chunk:
                        break
                    n += len(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
                log(f'  -> {target} {up.status} streamed={n}')
                self.close_connection = True
        except urllib.error.HTTPError as e:
            detail = e.read()[:2000]
            log(f'  -> {target} HTTP {e.code}: {detail[:500]!r}')
            self._send(e.code, detail or b'{"detail":"upstream error"}')
        except Exception as e:
            log(f'  -> {target} EXC {e}')
            self._send(502, json.dumps({"detail": f"shim upstream: {e}"}).encode())

if __name__ == '__main__':
    open(LOG_PATH, 'w').close()
    try:
        os.chmod(LOG_PATH, 0o600)  # request bodies are not logged, but session ids are
    except OSError:
        pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H)
    print(f'shim on {PORT} -> {LITELLM} model={MODEL}', flush=True)
    srv.serve_forever()
