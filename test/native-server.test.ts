import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * End-to-end test for the packaged native `bin/clm-server` (mlx-swift).
 *
 * Requires the real 8B model (~8.6 GB) and Apple Silicon, so it is opt-in:
 *   PI_CLM_NATIVE_MODEL=/path/to/model-snapshot npm test
 * Skips otherwise (the Swift-side parity against the Python engine is the
 * primary gate: `bin/clm-server parity test/fixtures/native-parity-reference.json`).
 */
const BIN = path.resolve(process.cwd(), "bin", "clm-server");
const MODEL = process.env.PI_CLM_NATIVE_MODEL;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function request(port: number, method: string, p: string, body?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: body ? { "Content-Type": "application/json" } : {} },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    // req.end(body) sets Content-Length; write()+end() would send chunked,
    // which the server (like the Python reference) rejects.
    req.end(body);
  });
}

test("native clm-server serves the System One wire API", async (t) => {
  if (!MODEL || !fs.existsSync(BIN)) {
    t.skip(`set PI_CLM_NATIVE_MODEL to run (bin exists: ${fs.existsSync(BIN)})`);
    return;
  }

  const port = await freePort();
  const child: ChildProcess = spawn(BIN, ["--port", String(port), "--model-path", MODEL], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  t.after(() => {
    child.kill("SIGTERM");
  });

  // Wait for the server (includes engine load)
  const deadline = Date.now() + 120_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const health = await request(port, "GET", "/health");
      if (health.status === 200) {
        up = true;
        break;
      }
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(up, "native server did not become healthy");

  const health = await request(port, "GET", "/health");
  assert.deepEqual(health.json, { status: "ok", model: "clm-latest" });

  const models = await request(port, "GET", "/v1/models");
  assert.equal(models.json.data[0].id, "clm-latest");

  const answer = await request(
    port,
    "POST",
    "/v1/systemone",
    JSON.stringify({
      model: "clm-latest",
      state: { issue: "customer was charged twice" },
      questions: {
        urgent: { type: "bool", instructions: "Is this urgent?" },
        disposition: {
          type: "choice",
          instructions: "How should this be handled?",
          criteria: { refund: "Issue a refund", deny: "Deny the claim", escalate: "Escalate to a human" },
        },
        severity: { type: "score", instructions: "Severity level.", criteria: [1, 2, 3, 4, 5] },
      },
    })
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.json.model, "clm-latest");
  const answers = answer.json.answers;
  assert.ok(answers.urgent.noul >= 0 && answers.urgent.noul <= 1);
  assert.ok(["refund", "deny", "escalate"].includes(answers.disposition.choice));
  const probs = Object.values(answers.disposition.probabilities) as number[];
  assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-4);
  assert.ok(answers.severity.score >= 0 && answers.severity.score <= 4);
  assert.equal(answer.json.usage.output_tokens, 0);
  assert.ok(Number.isInteger(answer.json.usage.input_tokens));

  const invalid = await request(
    port,
    "POST",
    "/v1/systemone",
    JSON.stringify({ model: "clm-latest", state: "x", questions: { q: { type: "noul" } }, temperature: 0 })
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, "temperature must be in (0, 100]");
});
