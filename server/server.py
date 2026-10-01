#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["mlx", "mlx-lm", "transformers", "huggingface-hub"]
# ///
"""Local System One API for CLM MLX. Inference is serialized on one thread."""
import argparse
import json
import logging
import math
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MODEL = "clm-latest"
MAX_BODY = 1024 * 1024


def validate(payload):
    if not isinstance(payload, dict):
        raise ValueError("request must be an object")
    if payload.get("model", MODEL) != MODEL:
        raise ValueError("unknown model")
    if "state" not in payload:
        raise ValueError("state is required")
    questions = payload.get("questions")
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 64:
        raise ValueError("questions must contain 1–64 questions")
    from clm_mlx import schema
    normalized = {}
    for name, question in questions.items():
        if not isinstance(question, dict):
            raise ValueError("each question must be an object")
        q = dict(question)
        if q.get("type") == "bool":
            q["type"] = "noul"
        keys, _ = schema.candidates(q)
        if len(keys) > 256:
            raise ValueError("maximum 256 candidates per question")
        normalized[name] = q
    temperature = payload.get("temperature", 1.0)
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not math.isfinite(temperature) or not 0 < temperature <= 100:
        raise ValueError("temperature must be in (0, 100]")
    return payload["state"], normalized, temperature


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status": "ok", "model": MODEL})
        elif self.path == "/v1/models":
            self.reply(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "local"}]})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/systemone":
            self.reply(404, {"error": "not found"})
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                raise ValueError("chunked requests are not supported")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY:
                self.reply(413, {"error": "body must be 1 byte to 1 MiB"})
                return
            raw = self.rfile.read(size)
            payload = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON number")))
            state, questions, temperature = validate(payload)
        except (ValueError, TypeError, UnicodeError) as exc:
            self.reply(400, {"error": str(exc)})
            return
        try:
            result = self.server.engine.answer(state, questions, temperature)
            result["model"] = MODEL
        except Exception:
            logging.exception("CLM inference failed")
            self.reply(500, {"error": "CLM inference failed; see server log"})
            return
        self.reply(200, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8700)
    parser.add_argument("--model-path", type=str, default=None, help="Path to CLM model directory")
    parser.add_argument("--truncation", choices=["head", "tail"], default="head")
    args = parser.parse_args()

    model_dir = Path(args.model_path).resolve() if args.model_path else Path(__file__).resolve().parent
    import sys
    if (model_dir / "clm_mlx").is_dir() and str(model_dir) not in sys.path:
        sys.path.insert(0, str(model_dir))

    from clm_mlx.engine import Engine
    # Load and execute on the same thread; MLX/cache access is never concurrent.
    engine = Engine(str(model_dir / "encoder"), str(model_dir / "heads"), cache_size=4096, truncation=args.truncation)
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    server.engine = engine
    print(f"CLM ready: http://127.0.0.1:{args.port}/v1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
