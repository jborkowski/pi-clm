import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import registerPlugin, { DEFAULT_PORT } from "../index.ts";

test("Extension index registration test suite", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-index-test-"));
  process.env.PI_CLM_CACHE_DIR = tempDir;

  t.after(async () => {
    delete process.env.PI_CLM_CACHE_DIR;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  await t.test("registers provider and handles classify with auto-start and shutdown", async () => {
    let registeredProviderId = "";
    let registeredConfig: any = null;
    const shutdownHandlers: Array<() => Promise<void>> = [];

    const mockPi: any = {
      registerProvider: (id: string, config: any) => {
        registeredProviderId = id;
        registeredConfig = config;
      },
      on: (event: string, handler: any) => {
        if (event === "session_shutdown") {
          shutdownHandlers.push(handler);
        }
      },
    };

    registerPlugin(mockPi);

    assert.equal(registeredProviderId, "clm-local");
    assert.equal(registeredConfig.apiKey, "local");
    assert.equal(registeredConfig.models.length, 1);
    assert.equal(registeredConfig.models[0].id, "clm-latest");
    assert.ok(registeredConfig.classifiers["typesafe-system-one"]);

    // Test that classify auto-starts server if not running
    // Setup a mock server answering on DEFAULT_PORT
    let healthHits = 0;
    let classifyHits = 0;
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        healthHits++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", model: "clm-latest" }));
      } else if (req.url === "/v1/systemone") {
        classifyHits++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          answers: { test: { type: "choice", choice: "a", probabilities: { a: 1.0 }, confidence: 1.0 } },
          model: "clm-latest",
          usage: { input_tokens: 10, output_tokens: 0 }
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(DEFAULT_PORT, "127.0.0.1", resolve));

    try {
      const classifier = registeredConfig.classifiers["typesafe-system-one"].classify;
      const model = registeredConfig.models[0];
      const context = {
        state: { msg: "hello" },
        questions: {
          test: {
            type: "choice",
            instructions: "Pick one",
            criteria: { a: "Option A" }
          }
        }
      };

      const result = await classifier(model, context, { apiKey: "local" });
      assert.equal(result.stopReason, "stop");
      assert.ok(result.answers.test);

      // Trigger session shutdown
      for (const handler of shutdownHandlers) {
        await handler();
      }
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });
});
