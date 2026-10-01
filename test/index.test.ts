import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import registerPlugin, { DEFAULT_PORT, ServerManager, MANIFEST_FILENAME } from "../index.ts";

test("Extension index end-to-end classify test suite", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-e2e-test-"));
  process.env.PI_CLM_CACHE_DIR = tempDir;

  t.after(async () => {
    delete process.env.PI_CLM_CACHE_DIR;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  await t.test("registers provider and handles classify with choice/bool/score questions and token usage", async () => {
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

    // Setup mock server answering on DEFAULT_PORT
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
        res.end(
          JSON.stringify({
            answers: {
              choice_q: {
                type: "choice",
                choice: "opt_a",
                probabilities: { opt_a: 0.88, opt_b: 0.12 },
                confidence: 0.88,
              },
              bool_q: {
                type: "noul",
                noul: 0.94,
              },
              score_q: {
                type: "score",
                score: 3,
                confidence: 0.77,
              },
            },
            model: "clm-latest",
            usage: { input_tokens: 120, output_tokens: 0 },
          })
        );
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
        state: { userText: "hello world" },
        questions: {
          choice_q: {
            type: "choice" as const,
            instructions: "Select one",
            criteria: { opt_a: "Option A", opt_b: "Option B" },
          },
          bool_q: {
            type: "bool" as const,
            instructions: "Is this positive?",
            criteria: { true: "Yes", false: "No" },
          },
          score_q: {
            type: "score" as const,
            instructions: "Score the quality 1-5",
            criteria: ["1", "2", "3", "4", "5"],
          },
        },
      };

      const result = await classifier(model, context, { apiKey: "local" });

      assert.equal(result.stopReason, "stop");
      assert.equal(result.model, "clm-latest");

      // Verify choice answer
      const choiceAns = result.answers.choice_q;
      assert.equal(choiceAns.type, "choice");
      assert.equal(choiceAns.choice, "opt_a");
      assert.equal(choiceAns.confidence, 0.88);
      assert.equal(choiceAns.probabilities.opt_a, 0.88);

      // Verify bool answer (mapped from wire noul)
      const boolAns = result.answers.bool_q;
      assert.equal(boolAns.type, "bool");
      assert.equal(boolAns.probability, 0.94);

      // Verify score answer
      const scoreAns = result.answers.score_q;
      assert.equal(scoreAns.type, "score");
      assert.equal(scoreAns.score, 3);
      assert.equal(scoreAns.confidence, 0.77);

      // Verify token usage flow
      assert.ok(result.usage);
      assert.equal(result.usage.input, 120);
      assert.equal(result.usage.output, 0);
      assert.equal(result.usage.totalTokens, 120);

      // Trigger session shutdown
      for (const handler of shutdownHandlers) {
        await handler();
      }
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  await t.test("first classify call triggers download and server start if needed", async () => {
    const testCache = await fsp.mkdtemp(path.join(tempDir, "first-call-test-"));
    const mockHfPort = 8798;
    const testServerPort = 8799;

    // Create mock HuggingFace server that serves model files
    const mockHf = http.createServer((req, res) => {
      if (req.url === "/api/models/mlx-community/CLM-v0.1-8B-MLX-4bit/tree/main?recursive=true") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { type: "file", path: "config.json", oid: "ece13c40d0461308f7b3d6f2252702267934bdb4", size: 12 },
          ])
        );
      } else if (req.url === "/mlx-community/CLM-v0.1-8B-MLX-4bit/resolve/main/config.json") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end("mock-config!");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => mockHf.listen(mockHfPort, "127.0.0.1", resolve));

    let registeredConfig: any = null;
    const mockPi: any = {
      registerProvider: (_id: string, config: any) => {
        registeredConfig = config;
      },
      on: () => {},
    };

    const modelOptions = {
      repo: "mlx-community/CLM-v0.1-8B-MLX-4bit",
      hfEndpoint: `http://127.0.0.1:${mockHfPort}`,
      cacheDir: testCache,
    };
    const serverManager = new ServerManager({
      cacheDir: testCache,
      port: testServerPort,
      modelPath: path.join(testCache, "models", "mlx-community--CLM-v0.1-8B-MLX-4bit"),
      serverScriptPath: path.resolve(process.cwd(), "test/fixtures/mock-server.py"),
    });

    registerPlugin(mockPi, {
      serverManager,
      modelOptions,
    });

    try {
      // Verify model is NOT yet downloaded in testCache
      const manifestPath = path.join(serverManager.getModelPath(), MANIFEST_FILENAME);
      const manifestBefore = await fsp.stat(manifestPath).catch(() => null);
      assert.equal(manifestBefore, null);

      // Invoke classify
      const classifier = registeredConfig.classifiers["typesafe-system-one"].classify;
      const model = registeredConfig.models[0];
      const result = await classifier(
        model,
        {
          state: { msg: "test" },
          questions: { q: { type: "choice", instructions: "q?", criteria: { yes: "yes" } } },
        },
        { apiKey: "local" }
      );

      assert.equal(result.stopReason, "stop");
      assert.equal(result.answers.q.choice, "yes");

      // Verify model WAS downloaded during classify call
      const manifestAfter = await fsp.stat(manifestPath).catch(() => null);
      assert.ok(manifestAfter !== null);
    } finally {
      await serverManager.stop();
      await new Promise((resolve) => mockHf.close(resolve));
    }
  });

  await t.test("works seamlessly when server is already running (second session)", async () => {
    const testCache = await fsp.mkdtemp(path.join(tempDir, "second-session-test-"));
    const serverPort = 8795;

    // Start a mock server representing already running server
    let classifyCalls = 0;
    const mockRunningServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", model: "clm-latest" }));
      } else if (req.url === "/v1/systemone") {
        classifyCalls++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            answers: { check: { type: "choice", choice: "ok", probabilities: { ok: 1.0 }, confidence: 1.0 } },
            model: "clm-latest",
            usage: { input_tokens: 25, output_tokens: 0 },
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => mockRunningServer.listen(serverPort, "127.0.0.1", resolve));

    try {
      // Session 1 starts and acquires reference
      const sm1 = new ServerManager({ cacheDir: testCache, port: serverPort });
      await sm1.start();
      const lock1 = await sm1.readLockFile();
      assert.ok(lock1);
      assert.equal(lock1.refCount, 1);

      // Session 2 runs classify
      let registeredConfig: any = null;
      const mockPi: any = {
        registerProvider: (_id: string, config: any) => {
          registeredConfig = config;
        },
        on: () => {},
      };
      const sm2 = new ServerManager({ cacheDir: testCache, port: serverPort });
      registerPlugin(mockPi, { serverManager: sm2 });

      const classifier = registeredConfig.classifiers["typesafe-system-one"].classify;
      const model = registeredConfig.models[0];
      const result = await classifier(
        model,
        {
          state: { active: true },
          questions: { check: { type: "choice", instructions: "ok?", criteria: { ok: "ok" } } },
        },
        { apiKey: "local" }
      );

      assert.equal(result.stopReason, "stop");
      assert.equal(result.answers.check.choice, "ok");
      assert.equal(classifyCalls, 1);

      // Lockfile should now show 2 sessions
      const lock2 = await sm2.readLockFile();
      assert.ok(lock2);
      assert.equal(lock2.refCount, 2);

      // Session 2 stops
      await sm2.stop();
      const lockAfterSm2 = await sm1.readLockFile();
      assert.ok(lockAfterSm2);
      assert.equal(lockAfterSm2.refCount, 1);

      // Session 1 stops
      await sm1.stop();
      const finalLock = await sm1.readLockFile();
      assert.equal(finalLock, null);
    } finally {
      await new Promise((resolve) => mockRunningServer.close(resolve));
    }
  });

  await t.test("error when server fails to start within timeout gives actionable message", async () => {
    const testCache = await fsp.mkdtemp(path.join(tempDir, "timeout-test-"));
    const serverPort = 8794;
    const mockHfPort = 8797;

    // Mock HF server: empty file tree so download() completes instantly without network
    const mockHf = http.createServer((req, res) => {
      if (req.url?.includes("/tree/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => mockHf.listen(mockHfPort, "127.0.0.1", resolve));

    const sm = new ServerManager({
      cacheDir: testCache,
      port: serverPort,
      serverScriptPath: path.resolve(process.cwd(), "test/fixtures/hang-server.py"),
      startupTimeoutMs: 300,
      healthIntervalMs: 50,
    });

    let registeredConfig: any = null;
    const mockPi: any = {
      registerProvider: (_id: string, config: any) => {
        registeredConfig = config;
      },
      on: () => {},
    };

    registerPlugin(mockPi, {
      serverManager: sm,
      modelOptions: {
        cacheDir: testCache,
        hfEndpoint: `http://127.0.0.1:${mockHfPort}`,
      },
    });

    // No cached model: the first classify call downloads (empty mock tree),
    // then hangs on server start until the startup timeout fires.

    const classifier = registeredConfig.classifiers["typesafe-system-one"].classify;
    const model = registeredConfig.models[0];

    await assert.rejects(
      async () => {
        await classifier(
          model,
          {
            state: {},
            questions: { q: { type: "choice", instructions: "q?", criteria: { a: "A" } } },
          },
          { apiKey: "local" }
        );
      },
      (err: Error) => {
        assert.match(err.message, /CLM server startup timed out after 300ms/);
        assert.match(err.message, /Check the log file at/);
        assert.match(err.message, /To diagnose issues manually, try running: uv run/);
        return true;
      }
    );
    await new Promise((resolve) => mockHf.close(resolve));
  });
});
