#!/usr/bin/env python3
"""
Local Laya server speaking TypeSafe Jev's wire format.

    pip install laya            # pulls torch + transformers (~2 GB); Python 3.10+
    python dev/laya_server.py   # first start downloads the checkpoint from Hugging Face (~850 MB)

Then point the game at it: config.mjs -> SETTINGS.laya.baseUrl = 'http://127.0.0.1:8000'
(the default). No API key: the game sends none and this server ignores any.

Endpoints
    GET  /              health  -> {"status": "ok", "model": ..., "device": ...}
    GET  /v1/models     -> {"models": [{"name": ..., "description": ..., "release_date": ...}]}
    POST /v1/systemone  {"model": ..., "state": ..., "questions": {...}}  -> Laya's answers, Jev-shaped

Options
    --model english | multilingual | typed-decisions | <local path>   (default: typed-decisions)
    --port 8000   --host 127.0.0.1   --device cpu | cuda | mps (default: auto)
"""

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHECKPOINTS = {
    "english": ("convaiinnovations/laya", None, "ModernBERT-large, 512-token context, English"),
    "multilingual": ("convaiinnovations/laya", "multilingual", "mmBERT-base, 1,024-token context, 100+ languages, fastest"),
    "typed-decisions": ("convaiinnovations/laya", "typed-decisions", "ModernBERT-large, 1,024-token context, fine-tuned for typed decisions"),
}


def load_agent(name, device):
    import laya  # noqa: WPS433 (imported here so --help works without torch)

    if name in CHECKPOINTS:
        repo, subfolder, _ = CHECKPOINTS[name]
        return laya.load(repo, device=device, subfolder=subfolder)
    return laya.load(name, device=device)


class Handler(BaseHTTPRequestHandler):
    agent = None
    model_name = "laya"
    lock = threading.Lock()

    def _send(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # quieter default log
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            return self._send(200, {"status": "ok", "model": self.model_name, "device": str(self.agent.device)})
        if self.path.startswith("/v1/models"):
            desc = CHECKPOINTS.get(self.model_name, (None, None, "local checkpoint"))[2]
            return self._send(200, {"models": [{"name": self.model_name, "description": "Laya (open weights, local) — " + desc, "release_date": "2026-09-16"}]})
        return self._send(404, {"error": {"message": "no route " + self.path}})

    def do_POST(self):
        if not self.path.startswith("/v1/systemone"):
            return self._send(404, {"error": {"message": "no route " + self.path}})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:  # noqa: BLE001
            return self._send(400, {"error": {"message": "invalid JSON: %s" % exc}})
        questions = body.get("questions")
        if not isinstance(questions, dict) or not questions:
            return self._send(422, {"error": {"message": "questions is required (a non-empty object)"}})
        for name, q in questions.items():
            if not isinstance(q, dict) or q.get("type") not in ("choice", "score", "noul"):
                return self._send(422, {"error": {"message": "question %r must have type choice | score | noul" % name}})
            if not q.get("instructions"):
                q["instructions"] = name.replace("_", " ")  # Laya requires instructions; Jev does not
        state = body.get("state", "")
        started = time.perf_counter()
        try:
            with self.lock:  # one forward pass at a time
                result = self.agent.system_one(state, questions)
        except ValueError as exc:  # e.g. options exceed head_max_len
            return self._send(422, {"error": {"message": str(exc)}})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": {"message": "inference failed: %s" % exc}})
        result["model"] = self.model_name
        result["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
        self.send_response(200)
        data = json.dumps(result).encode("utf-8")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("x-laya-latency-ms", str(result["latency_ms"]))
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser(description="Serve Laya locally behind Jev's wire format")
    ap.add_argument("--model", default="typed-decisions", help="english | multilingual | typed-decisions | local path")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--device", default=None, help="cpu | cuda | mps (default: auto)")
    args = ap.parse_args()

    print("Loading Laya checkpoint %r (first start downloads it from Hugging Face)..." % args.model, flush=True)
    t0 = time.perf_counter()
    try:
        agent = load_agent(args.model, args.device)
    except ImportError:
        print("The 'laya' package is not installed. Run:  pip install laya", file=sys.stderr)
        sys.exit(1)
    print("Loaded in %.1f s on %s" % (time.perf_counter() - t0, agent.device), flush=True)

    # warm-up so the first game call is not the slow one
    agent.system_one("warm-up", {"ok": {"type": "noul", "instructions": "Is this a warm-up?"}})

    Handler.agent = agent
    Handler.model_name = args.model
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("Laya server listening on http://%s:%d  (POST /v1/systemone)" % (args.host, args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
