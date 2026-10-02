// Minimal CLM wire-protocol mock for tests: same endpoints as the real
// server, without any model. Pure Node so the test fake servers just exec
// `node` — no Python, no version-manager shims, no firewall surprises.
import http from "node:http";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx !== -1 && args[portIdx + 1] ? Number(args[portIdx + 1]) : 8799;

const server = http.createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") {
    json(200, { status: "ok", model: "clm-latest" });
  } else if (req.method === "POST" && req.url === "/v1/systemone") {
    req.resume();
    req.on("end", () => {
      json(200, {
        answers: { q: { type: "choice", choice: "yes", probabilities: { yes: 1.0 }, confidence: 1.0 } },
        model: "clm-latest",
        usage: { input_tokens: 15, output_tokens: 0 },
      });
    });
  } else {
    json(404, {});
  }
});

server.listen(port, "127.0.0.1");
