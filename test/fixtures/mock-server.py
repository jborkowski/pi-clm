import sys, json
from http.server import BaseHTTPRequestHandler, HTTPServer

port = 8799
for i, arg in enumerate(sys.argv):
    if arg == "--port" and i + 1 < len(sys.argv):
        port = int(sys.argv[i + 1])

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "model": "clm-latest"}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/v1/systemone":
            size = int(self.headers.get("Content-Length", 0))
            self.rfile.read(size)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "answers": {"q": {"type": "choice", "choice": "yes", "probabilities": {"yes": 1.0}, "confidence": 1.0}},
                "model": "clm-latest",
                "usage": {"input_tokens": 15, "output_tokens": 0}
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

server = HTTPServer(("127.0.0.1", port), Handler)
try:
    server.serve_forever()
finally:
    server.server_close()
