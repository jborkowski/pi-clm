import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import registerPlugin, {
  ServerManager,
  MANIFEST_FILENAME,
  ClmStatusTracker,
  isProcessRunning,
  saveConfig,
} from "../index.ts";
import { freePort } from "./helpers.ts";

const MOCK_COMMIT_SHA = "e".repeat(40);

  /** Mock ExtensionAPI capturing session handlers and the /clm command. */
  const makeRecordingPi = (sessionHandlers: Record<string, any>) => ({
    registerProvider: () => {},
    on: (event: string, handler: any) => {
      sessionHandlers[event] = handler;
    },
    registerCommand: () => {},
    registerTool: () => {},
  });

test("Extension index end-to-end classify test suite", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-e2e-test-"));
  const hubCacheDir = path.join(tempDir, "hf-hub");
  await fsp.mkdir(hubCacheDir, { recursive: true });
  // Keep lock/log state and HF hub cache resolution hermetic. The mock-model
  // subtests exercise the `uv run server.py` fallback; the packaged native
  // binary (which requires the real 8B model) is covered by the dedicated
  // native e2e test file.
  process.env.PI_CLM_STATE_DIR = tempDir;
  process.env.HF_HUB_CACHE = hubCacheDir;
  process.env.PI_CLM_SERVER_BIN = "";
  // A real CLM server may be running on the default port (e.g. the user ran
  // `make serve`); route all ServerManager defaults to a free port instead.
  const defaultPort = await freePort();
  process.env.PI_CLM_PORT = String(defaultPort);

  t.after(async () => {
    delete process.env.PI_CLM_STATE_DIR;
    delete process.env.HF_HUB_CACHE;
    delete process.env.PI_CLM_SERVER_BIN;
    delete process.env.PI_CLM_PORT;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  /** Mock ExtensionAPI capturing the registered provider config and shutdown handlers. */
  const makeMockPi = (onRegister?: (id: string, config: any) => void) => {
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const pi: any = {
      registerProvider: (id: string, config: any) => onRegister?.(id, config),
      on: (event: string, handler: any) => {
        if (event === "session_shutdown") shutdownHandlers.push(handler);
      },
      registerCommand: () => {},
      registerTool: () => {},
    };
    return { pi, shutdownHandlers };
  };

  /** Mock HuggingFace server serving a one-file repo tree by default. */
  const startMockHf = (port: number, tree: unknown[] = [
    { type: "file", path: "config.json", oid: "ece13c40d0461308f7b3d6f2252702267934bdb4", size: 12 },
  ]): Promise<http.Server> => {
    const server = http.createServer((req, res) => {
      if (req.url?.includes("/revision/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sha: MOCK_COMMIT_SHA }));
      } else if (req.url?.includes("/tree/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tree));
      } else if (req.url?.includes("/resolve/main/config.json")) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end("mock-config!");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
  };
  const closeServer = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

  /** Real child process answering /health, standing in for a running CLM server. */
  const spawnHealthServer = (port: number) =>
    spawn(
      process.execPath,
      [
        "-e",
        `const http=require("http");http.createServer((req,res)=>{if(req.url==="/health"){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({status:"ok",model:"clm-latest"}));}else{res.writeHead(404);res.end();}}).listen(${port},"127.0.0.1");`,
      ],
      { stdio: "ignore" }
    );

  const waitForServer = async (port: number): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 500 }, (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`health server on port ${port} never came up`);
  };

  /** Mock ExtensionAPI capturing registered commands (plus event handlers when a store is given). */
  const makeCommandPi = (commands: Record<string, any>, eventHandlers?: Record<string, any>) => {
    const pi: any = {
      registerProvider: () => {},
      on: (event: string, handler: any) => {
        if (eventHandlers) eventHandlers[event] = handler;
      },
      registerCommand: (id: string, config: any) => {
        commands[id] = config;
      },
    };
    return pi;
  };

  /** Quantization-menu selector: picks 4-bit, falling back to the first model entry. */
  const pick4Bit = async (_title: string, options: string[]) =>
    options.find((o) => o.includes("4-bit")) ?? options[0];

  /** JSON-mode command ctx collecting notify messages and using the given menu selector. */
  const makeConfigureCtx = (
    notify: (message: string, level: string) => void,
    select: (title: string, options: string[]) => Promise<string | undefined> = pick4Bit
  ): any => ({
    mode: "json",
    hasUI: false,
    ui: { notify, select, custom: () => {}, setWidget: () => {} },
  });

  /** Registers the plugin on a command-capturing mock with a fresh status tracker, runs /clm configure once, and returns the tracker plus captured notifications. */
  const runConfigureCommand = async (
    pluginOptions: Record<string, any> = {},
    pickVariant: (title: string, options: string[]) => Promise<string | undefined> = pick4Bit
  ) => {
    const commands: Record<string, any> = {};
    const mockPi = makeCommandPi(commands);
    const tracker = new ClmStatusTracker();
    await registerPlugin(mockPi, { ...pluginOptions, statusTracker: tracker });
    const notifications: string[] = [];
    const ctx = makeConfigureCtx((m: string) => notifications.push(m), pickVariant);
    await commands["clm"].handler("configure", ctx);
    return { tracker, notifications };
  };

  /** Fires session_start with a bare collecting UI ctx; notices land in the sink. */
  const emitSessionStart = async (sessionHandlers: Record<string, any>, sink: string[]) => {
    await sessionHandlers["session_start"]({}, { ui: { notify: (m: string) => sink.push(m) } });
  };

  await t.test("registers provider and handles classify with choice/bool/score questions and token usage", async () => {
    let registeredProviderId = "";
    let registeredConfig: any = null;

    const { pi: mockPi, shutdownHandlers } = makeMockPi((id, config) => {
      registeredProviderId = id;
      registeredConfig = config;
    });

    await registerPlugin(mockPi);

    assert.equal(registeredProviderId, "clm-local");
    assert.equal(registeredConfig.apiKey, "local");
    assert.equal(registeredConfig.models.length, 1);
    assert.equal(registeredConfig.models[0].id, "clm-latest");
    assert.ok(registeredConfig.classifiers["typesafe-system-one"]);

    // Setup mock server answering on the (free) default port
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

    await new Promise<void>((resolve) => mockServer.listen(defaultPort, "127.0.0.1", resolve));

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

      const choiceAns = result.answers.choice_q;
      assert.equal(choiceAns.type, "choice");
      assert.equal(choiceAns.choice, "opt_a");
      assert.equal(choiceAns.confidence, 0.88);
      assert.equal(choiceAns.probabilities.opt_a, 0.88);

      const boolAns = result.answers.bool_q;
      assert.equal(boolAns.type, "bool");
      assert.equal(boolAns.probability, 0.94);

      const scoreAns = result.answers.score_q;
      assert.equal(scoreAns.type, "score");
      assert.equal(scoreAns.score, 3);
      assert.equal(scoreAns.confidence, 0.77);

      assert.ok(result.usage);
      assert.equal(result.usage.input, 120);
      assert.equal(result.usage.output, 0);
      assert.equal(result.usage.totalTokens, 120);

      for (const handler of shutdownHandlers) {
        await handler();
      }
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  await t.test("codemode tools execute against the wire API and return structured ClmAnswers", async () => {
    const port = await freePort();
    const wireRequests: any[] = [];
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", model: "clm-latest" }));
      } else if (req.url === "/v1/systemone") {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          const body = JSON.parse(data);
          wireRequests.push(body);
          const q = body.questions.q;
          if (q.instructions.includes("boom")) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "simulated classifier failure" }));
            return;
          }
          // Mirror real server answer shapes: bool arrives as wire-level
          // `noul`, choice carries the distribution, and score is a
          // CONTINUOUS expected index (fractional for real distributions).
          const answer =
            q.type === "noul"
              ? { type: "noul", noul: 0.8 }
              : q.type === "choice"
                ? { type: "choice", choice: "deny", probabilities: { refund: 0.2, deny: 0.7, escalate: 0.1 }, confidence: 0.7 }
                : { type: "score", score: 2.2, confidence: 0.6 };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ answers: { q: answer }, usage: { input_tokens: 7, output_tokens: 0 } }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => mockServer.listen(port, "127.0.0.1", resolve));

    const registeredTools: any[] = [];
    const toolPi: any = {
      registerProvider: () => {},
      on: () => {},
      registerCommand: () => {},
      registerTool: (config: any) => registeredTools.push(config),
    };
    const serverManager = new ServerManager({ stateDir: tempDir, port, host: "127.0.0.1" });
    registerPlugin(toolPi, { serverManager });

    const byName = Object.fromEntries(registeredTools.map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(byName).sort(), ["clm_bool", "clm_choice", "clm_score"]);
    for (const tool of registeredTools) {
      assert.ok(tool.outputSchema, `${tool.name} must declare an outputSchema so codemode gets structuredContent`);
    }

    try {
      const [boolRes, choiceRes, scoreRes] = await Promise.all([
        byName.clm_bool.execute("c1", { question: "Is this urgent?" }),
        byName.clm_choice.execute("c2", {
          question: "How should this be handled?",
          criteria: { refund: "Issue a refund", deny: "Deny the claim", escalate: "Escalate" },
        }),
        byName.clm_score.execute("c3", { question: "Rate severity.", criteria: [1, 2, 3, 4, 5] }),
      ]);

      assert.deepEqual(boolRes.structuredContent, {
        answer: "yes",
        probabilities: { yes: 0.8, no: 1 - 0.8 },
        confidence: 0.8,
        question: "Is this urgent?",
      });
      // The text content mirrors the structure; codemode scripts get structuredContent.
      assert.deepEqual(JSON.parse(boolRes.content[0].text), boolRes.structuredContent);

      assert.equal(choiceRes.structuredContent.answer, "deny");
      assert.equal(choiceRes.structuredContent.probabilities.deny, 0.7);
      assert.equal(choiceRes.structuredContent.confidence, 0.7);
      assert.deepEqual(
        Object.keys(choiceRes.structuredContent.probabilities).sort(),
        ["deny", "escalate", "refund"],
      );

      // The wire protocol reports a continuous expected index: 2.2 must map
      // to the nearest criterion ("3" / value 3), not leak a raw fraction.
      assert.deepEqual(scoreRes.structuredContent, {
        answer: "3",
        value: 3,
        confidence: 0.6,
        question: "Rate severity.",
      });

      // Default state is { message: question }; an explicit state is classified instead.
      await byName.clm_score.execute("c4", { question: "Rate severity.", state: { message: "Customer was charged twice" } });
      assert.equal(wireRequests[0].state.message, "Is this urgent?");
      assert.equal(wireRequests[0].questions.q.type, "noul");
      const last = wireRequests[wireRequests.length - 1];
      assert.equal(last.state.message, "Customer was charged twice");
      assert.equal(last.questions.q.instructions, "Rate severity.");
      assert.deepEqual(last.questions.q.criteria, ["1", "2", "3", "4", "5"]);

      // Classifier failures reject instead of returning malformed answers.
      await assert.rejects(byName.clm_bool.execute("c5", { question: "boom" }), /error/i);
    } finally {
      await serverManager.stop();
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  await t.test("first classify call triggers download and server start if needed", async () => {
    const testCache = await fsp.mkdtemp(path.join(tempDir, "first-call-test-"));
    const mockHfPort = 8798;
    const testServerPort = 8799;

    const mockHf = await startMockHf(mockHfPort);

    let registeredConfig: any = null;
    const { pi: mockPi } = makeMockPi((_id, config) => {
      registeredConfig = config;
    });

    const modelRepo = "mlx-community/CLM-v0.1-8B-MLX-4bit";
    const serverManager = new ServerManager({
      stateDir: testCache,
      hubCacheDir: testCache,
      modelRepo,
      port: testServerPort,
      serverScriptPath: path.resolve(process.cwd(), "test/fixtures/mock-server.py"),
    });

    await registerPlugin(mockPi, {
      serverManager,
      modelOptions: {
        repo: modelRepo,
        hfEndpoint: `http://127.0.0.1:${mockHfPort}`,
        cacheDir: testCache,
      },
    });

    try {
      const manifestPath = path.join(
        testCache,
        "models--mlx-community--CLM-v0.1-8B-MLX-4bit",
        "snapshots",
        MOCK_COMMIT_SHA,
        MANIFEST_FILENAME
      );
      const manifestBefore = await fsp.stat(manifestPath).catch(() => null);
      assert.equal(manifestBefore, null);

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
      const sm1 = new ServerManager({ stateDir: testCache, port: serverPort });
      await sm1.start();
      const lock1 = await sm1.readLockFile();
      assert.ok(lock1);
      assert.equal(lock1.refCount, 1);

      let registeredConfig: any = null;
      const { pi: mockPi } = makeMockPi((_id, config) => {
        registeredConfig = config;
      });
      const sm2 = new ServerManager({ stateDir: testCache, port: serverPort });
      await registerPlugin(mockPi, { serverManager: sm2 });

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

      const lock2 = await sm2.readLockFile();
      assert.ok(lock2);
      assert.equal(lock2.refCount, 2);

      await sm2.stop();
      const lockAfterSm2 = await sm1.readLockFile();
      assert.ok(lockAfterSm2);
      assert.equal(lockAfterSm2.refCount, 1);

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
    const mockHf = await startMockHf(mockHfPort, []);

    const sm = new ServerManager({
      stateDir: testCache,
      hubCacheDir: testCache,
      port: serverPort,
      serverScriptPath: path.resolve(process.cwd(), "test/fixtures/hang-server.py"),
      startupTimeoutMs: 300,
      healthIntervalMs: 50,
    });

    let registeredConfig: any = null;
    const { pi: mockPi } = makeMockPi((_id, config) => {
      registeredConfig = config;
    });

    await registerPlugin(mockPi, {
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

  await t.test("status tracker reflects lifecycle: download -> server-starting -> ready, and error state", async () => {
    const testCache = await fsp.mkdtemp(path.join(tempDir, "tracker-test-"));
    const mockHfPort = 8793;
    const serverPort = 8792;

    const mockHf = await startMockHf(mockHfPort);

    let registeredConfig: any = null;
    const { pi: mockPi, shutdownHandlers } = makeMockPi((_id, config) => {
      registeredConfig = config;
    });

    const tracker = new ClmStatusTracker();
    const seenStates: string[] = [];
    tracker.subscribe((s) => seenStates.push(s.state));

    const serverManager = new ServerManager({
      stateDir: testCache,
      hubCacheDir: testCache,
      modelRepo: "mlx-community/CLM-v0.1-8B-MLX-4bit",
      port: serverPort,
      serverScriptPath: path.resolve(process.cwd(), "test/fixtures/mock-server.py"),
    });

    await registerPlugin(mockPi, {
      serverManager,
      modelOptions: {
        repo: "mlx-community/CLM-v0.1-8B-MLX-4bit",
        hfEndpoint: "http://127.0.0.1:" + mockHfPort,
        cacheDir: testCache,
      },
      statusTracker: tracker,
    });

    const classifier = registeredConfig.classifiers["typesafe-system-one"].classify;
    const result = await classifier(
      registeredConfig.models[0],
      { state: {}, questions: { q: { type: "choice", instructions: "q?", criteria: { yes: "y" } } } },
      { apiKey: "local" }
    );
    assert.equal(result.stopReason, "stop");
    assert.equal(tracker.getState(), "ready");
    assert.equal(tracker.snapshot().lastError, null);
    assert.ok(seenStates.includes("downloading"), "states: " + seenStates.join(","));
    assert.ok(seenStates.includes("server-starting"), "states: " + seenStates.join(","));

    for (const handler of shutdownHandlers) {
      await handler();
    }
    assert.equal(tracker.getState(), "downloaded");

    await new Promise((resolve) => mockHf.close(resolve));
  });

  await t.test("/clm command adapts to ctx.mode and drives the TUI panel", async () => {
    let commandConfig: any = null;
    const sessionHandlers: Record<string, any> = {};
    const mockPi: any = {
      registerProvider: () => {},
      on: () => {},
      registerTool: () => {},
      registerCommand: (_id: string, config: any) => {
        commandConfig = config;
      },
    };
    await registerPlugin(mockPi);

    assert.ok(commandConfig);
    assert.ok(commandConfig.description.length > 0);

    const notifications: string[] = [];
    let customCalled = false;
    const nonTuiCtx: any = {
      mode: "json",
      hasUI: false,
      ui: {
        notify: (m: string) => notifications.push(m),
        custom: async () => {
          customCalled = true;
          throw new Error("custom must not be called in non-TUI mode");
        },
        setWidget: () => {},
      },
    };
    await commandConfig.handler("", nonTuiCtx);
    assert.equal(customCalled, false);
    assert.ok(notifications.length > 0);
    assert.ok(notifications.some((n) => n.includes("CLM")));

    notifications.length = 0;
    await commandConfig.handler("status", nonTuiCtx);
    assert.equal(customCalled, false);
    assert.ok(notifications.some((n) => n.includes("not downloaded")));

    notifications.length = 0;
    await commandConfig.handler("stop", nonTuiCtx);
    assert.ok(notifications.includes("CLM: server stopped"));

    const tuiNotifications: string[] = [];
    const tuiOnlyCtx: any = {
      mode: "tui",
      hasUI: true,
      ui: { notify: (m: string) => tuiNotifications.push(m), custom: () => {}, setWidget: () => {} },
    };
    await commandConfig.handler("stop", tuiOnlyCtx);
    assert.ok(tuiNotifications.includes("CLM: server stopped"));

    // /clm start: attaches to an already-healthy server without downloading
    // (mock on defaultPort — the port this plugin's ServerManager already has)
    const mockStart = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", model: "clm-latest" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => mockStart.listen(defaultPort, "127.0.0.1", resolve));
    try {
      const startNotifications: string[] = [];
      const startCtx: any = {
        mode: "json",
        hasUI: false,
        ui: {
          notify: (m: string) => startNotifications.push(m),
          custom: () => {
            throw new Error("custom must not be called for /clm start");
          },
          setWidget: () => {},
        },
      };
      await commandConfig.handler("start", startCtx);
      assert.ok(startNotifications.includes("CLM: ready"));
      // detach cleanly so no lock outlives the subtest
      await commandConfig.handler("stop", startCtx);
    } finally {
      await new Promise<void>((resolve) => mockStart.close(() => resolve()));
    }

    let panelFactory: any = null;
    const tuiCtx: any = {
      mode: "tui",
      hasUI: true,
      ui: {
        notify: () => {},
        custom: async (factory: any) => {
          panelFactory = factory;
          return null;
        },
        setWidget: () => {},
      },
    };
    await commandConfig.handler("", tuiCtx);
    assert.ok(panelFactory);

    const doneResults: any[] = [];
    const panel = panelFactory(
      { requestRender: () => {} },
      { fg: (_t: string, s: string) => s },
      {},
      (result: any) => doneResults.push(result)
    );
    const lines: string[] = panel.render(80);
    assert.ok(lines.every((l: string) => l.length <= 80));
    assert.ok(lines.some((l: string) => l.includes("CLM")));

    panel.handleInput("q");
    assert.deepEqual(doneResults, [null]);
    panel.dispose?.();
  });

  await t.test("/clm configure menu persists the choice and applies the repo", async () => {
    const configureDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-configure-test-"));
    const prevEnv = process.env.PI_CLM_STATE_DIR;
    process.env.PI_CLM_STATE_DIR = configureDir;
    try {
      const commands: Record<string, any> = {};
      const { pi: mockPi } = makeMockPi();
      mockPi.registerCommand = (id: string, config: any) => {
        commands[id] = config;
      };
      await registerPlugin(mockPi);
      const commandConfig = commands["clm"];

      const selections: string[] = [];
      const notifications: string[] = [];
      const ctx: any = {
        mode: "json",
        hasUI: false,
        ui: {
          notify: (m: string, _l: string) => notifications.push(m),
          select: async (_title: string, options: string[]) => {
            // Model menu: take the first entry; quantization menu: pick 4-bit
            const pick = options.find((o) => o.includes("4-bit")) ?? options[0];
            selections.push(pick ?? "");
            return pick;
          },
          custom: () => {},
          setWidget: () => {},
        },
      };

      await commandConfig.handler("configure", ctx);

      // Both menu levels were shown (model, then quantization)
      assert.equal(selections.length, 2);
      assert.match(selections[1], /4\.7 GB/);
      assert.match(selections[1], /91\.4%/);
      assert.ok(notifications.some((n) => n.includes("mlx-community/CLM-v0.1-8B-MLX-4bit")));

      // Choice persisted in the config file
      const saved = JSON.parse(await fsp.readFile(path.join(configureDir, "config.json"), "utf-8"));
      assert.deepEqual(saved, { modelId: "CLM-v0.1-8B", quantizationId: "4bit" });

      // A fresh session picks the saved choice up and routes the model repo accordingly
      const sm = new ServerManager({ stateDir: configureDir });
      const { pi: mockPi2 } = makeMockPi(() => {});
      await registerPlugin(mockPi2, { serverManager: sm, statusTracker: new ClmStatusTracker() });
      // Startup wiring: the persisted choice drives downloads and server starts
      assert.equal(sm.getModelRepo(), "mlx-community/CLM-v0.1-8B-MLX-4bit");
      assert.equal(sm.getModelOptions().repo, "mlx-community/CLM-v0.1-8B-MLX-4bit");
      assert.match(sm.getModelPath(), /models--mlx-community--CLM-v0\.1-8B-MLX-4bit/);
      await sm.stop();

      // Cancelling at the first prompt leaves everything untouched
      let cancelled = false;
      const ctxCancel: any = {
        mode: "json",
        ui: {
          notify: (m: string) => notifications.push(m),
          select: async () => undefined,
          custom: () => {},
          setWidget: () => {},
        },
      };
      await commandConfig.handler("configure", ctxCancel);
      cancelled = true;
      assert.ok(cancelled);
      assert.ok(notifications.some((n) => n.includes("cancelled")));
      const after = JSON.parse(await fsp.readFile(path.join(configureDir, "config.json"), "utf-8"));
      assert.deepEqual(after, { modelId: "CLM-v0.1-8B", quantizationId: "4bit" });
    } finally {
      if (prevEnv === undefined) delete process.env.PI_CLM_STATE_DIR;
      else process.env.PI_CLM_STATE_DIR = prevEnv;
      await fsp.rm(configureDir, { recursive: true, force: true });
    }
  });

  await t.test("/clm configure warns when a shared server keeps serving the old variant", async () => {
    const sharedDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-shared-cfg-"));
    const port = await freePort();
    const child = spawnHealthServer(port);
    try {
      await waitForServer(port);

      const sm = new ServerManager({ stateDir: sharedDir, port });
      await sm.writeLockFile({
        pid: child.pid!,
        port,
        host: "127.0.0.1",
        modelPath: "/models--mlx-community--CLM-v0.1-8B-MLX-8bit",
        startedAt: new Date().toISOString(),
        refCount: 2,
        sessions: [sm.getSessionId(), "session-other"],
      });

      const { tracker, notifications } = await runConfigureCommand({ serverManager: sm });

      // Told plainly: the old variant keeps serving until that server stops
      assert.ok(
        notifications.some((n) => n.includes("keeps serving the previous variant until it stops")),
        notifications.join("\n")
      );
      assert.ok(!notifications.some((n) => n.includes("server stopped; it will start")));

      // The shared server was not killed and the other session keeps its lock entry
      assert.equal(child.exitCode, null);
      assert.equal(tracker.getState(), "ready");
      const lock = await sm.readLockFile();
      assert.ok(lock);
      assert.deepEqual(lock!.sessions, ["session-other"]);
      assert.equal(lock!.refCount, 1);
      assert.equal(sm.getModelRepo(), "mlx-community/CLM-v0.1-8B-MLX-4bit");
      const saved = JSON.parse(await fsp.readFile(path.join(sharedDir, "config.json"), "utf-8"));
      assert.deepEqual(saved, { modelId: "CLM-v0.1-8B", quantizationId: "4bit" });
    } finally {
      child.kill("SIGKILL");
      await fsp.rm(sharedDir, { recursive: true, force: true });
    }
  });

  await t.test("/clm configure stops a solely owned server for the new variant", async () => {
    const ownedDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-owned-cfg-"));
    const port = await freePort();
    const child = spawnHealthServer(port);
    try {
      await waitForServer(port);

      const sm = new ServerManager({ stateDir: ownedDir, port });
      await sm.writeLockFile({
        pid: child.pid!,
        port,
        host: "127.0.0.1",
        modelPath: "/models--mlx-community--CLM-v0.1-8B-MLX-8bit",
        startedAt: new Date().toISOString(),
        refCount: 1,
        sessions: [sm.getSessionId()],
      });

      const { tracker, notifications } = await runConfigureCommand({ serverManager: sm });

      assert.ok(
        notifications.some((n) => n.includes("server stopped; it will start with the new variant on next use")),
        notifications.join("\n")
      );
      assert.equal(await sm.readLockFile(), null);
      assert.equal(tracker.getState(), "downloaded");
      for (let i = 0; i < 40 && isProcessRunning(child.pid!); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(isProcessRunning(child.pid!), false);
    } finally {
      child.kill("SIGKILL");
      await fsp.rm(ownedDir, { recursive: true, force: true });
    }
  });

  await t.test("/clm configure explains the Python fallback for non-8-bit variants when a native server exists", async () => {
    const warnDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-native-warn-"));
    const fakeBin = path.join(warnDir, "fake-clm-server");
    await fsp.writeFile(fakeBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const prevBin = process.env.PI_CLM_SERVER_BIN;
    const extraDirs: string[] = [];
    try {
      // 4-bit pick with a native binary present: plain warning, choice still applied
      process.env.PI_CLM_SERVER_BIN = fakeBin;
      const sm = new ServerManager({ stateDir: warnDir });
      const { notifications } = await runConfigureCommand({ serverManager: sm });
      assert.ok(
        notifications.some((n) => n.includes("native server supports the 8-bit checkpoint only")),
        notifications.join("\n")
      );
      assert.ok(notifications.some((n) => n.includes("Python fallback")), notifications.join("\n"));
      assert.equal(sm.getModelRepo(), "mlx-community/CLM-v0.1-8B-MLX-4bit");
      const saved = JSON.parse(await fsp.readFile(path.join(warnDir, "config.json"), "utf-8"));
      assert.deepEqual(saved, { modelId: "CLM-v0.1-8B", quantizationId: "4bit" });

      // Without a native binary the same pick needs no warning
      process.env.PI_CLM_SERVER_BIN = "";
      const plainDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-native-plain-"));
      extraDirs.push(plainDir);
      const noNative = await runConfigureCommand({ serverManager: new ServerManager({ stateDir: plainDir }) });
      assert.ok(
        !noNative.notifications.some((n) => n.includes("native server supports")),
        noNative.notifications.join("\n")
      );

      // The 8-bit variant keeps the native server and needs no warning
      process.env.PI_CLM_SERVER_BIN = fakeBin;
      const bit8Dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-native-8bit-"));
      extraDirs.push(bit8Dir);
      const sm8 = new ServerManager({ stateDir: bit8Dir });
      const pick8Bit = async (_title: string, options: string[]) =>
        options.find((o) => o.includes("8B 8-bit")) ?? options[0];
      const eightBit = await runConfigureCommand({ serverManager: sm8 }, pick8Bit);
      assert.ok(
        !eightBit.notifications.some((n) => n.includes("native server supports")),
        eightBit.notifications.join("\n")
      );
      assert.equal(sm8.getModelRepo(), "mlx-community/CLM-v0.1-8B-MLX-8bit");
    } finally {
      if (prevBin === undefined) delete process.env.PI_CLM_SERVER_BIN;
      else process.env.PI_CLM_SERVER_BIN = prevBin;
      await fsp.rm(warnDir, { recursive: true, force: true });
      for (const dir of extraDirs) await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("first-use notice disappears once a choice is saved", async () => {
    const noticeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-notice-"));
    const prevEnv = process.env.PI_CLM_STATE_DIR;
    process.env.PI_CLM_STATE_DIR = noticeDir;
    try {
      const sessionHandlers: Record<string, any> = {};
      const commands: Record<string, any> = {};
      const mockPi = makeCommandPi(commands, sessionHandlers);
      await registerPlugin(mockPi);

      const notices: string[] = [];
      await emitSessionStart(sessionHandlers, notices);
      assert.ok(notices.some((n) => n.includes("no model variant chosen yet")), notices.join("\n"));

      notices.length = 0;
      const ctx: any = makeConfigureCtx((m: string) => notices.push(m));
      await commands["clm"].handler("configure", ctx);
      assert.ok(notices.some((n) => n.includes("mlx-community/CLM-v0.1-8B-MLX-4bit")));

      notices.length = 0;
      await emitSessionStart(sessionHandlers, notices);
      assert.equal(notices.length, 0);
    } finally {
      if (prevEnv === undefined) delete process.env.PI_CLM_STATE_DIR;
      else process.env.PI_CLM_STATE_DIR = prevEnv;
      await fsp.rm(noticeDir, { recursive: true, force: true });
    }
  });

  await t.test("/clm configure failures surface through the CLM error channel", async () => {
    const errBase = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-cfg-err-"));
    // A state dir occupied by a regular file makes every config write fail
    const statePath = path.join(errBase, "not-a-dir");
    await fsp.writeFile(statePath, "occupied", "utf-8");
    const prevEnv = process.env.PI_CLM_STATE_DIR;
    process.env.PI_CLM_STATE_DIR = statePath;
    try {
      const commands: Record<string, any> = {};
      const mockPi = makeCommandPi(commands);
      const tracker = new ClmStatusTracker();
      await registerPlugin(mockPi, { statusTracker: tracker });

      const notified: Array<{ message: string; level: string }> = [];
      const ctx: any = makeConfigureCtx((m: string, level: string) => notified.push({ message: m, level }));
      // Resolves instead of rejecting: the handler reports the failure itself
      await commands["clm"].handler("configure", ctx);

      assert.equal(notified.length, 1);
      assert.equal(notified[0].level, "error");
      assert.ok(notified[0].message.startsWith("CLM: "), notified[0].message);
      assert.equal(tracker.getState(), "error");
      assert.equal(tracker.snapshot().lastError, notified[0].message.slice("CLM: ".length));
    } finally {
      if (prevEnv === undefined) delete process.env.PI_CLM_STATE_DIR;
      else process.env.PI_CLM_STATE_DIR = prevEnv;
      await fsp.rm(errBase, { recursive: true, force: true });
    }
  });

  await t.test("saved choice overrides a pinned modelOptions.repo", async () => {
    const overrideDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-override-cfg-"));
    const prevEnv = process.env.PI_CLM_STATE_DIR;
    process.env.PI_CLM_STATE_DIR = overrideDir;
    try {
      // A previous session saved a 4-bit choice
      await saveConfig({ modelId: "CLM-v0.1-8B", quantizationId: "4bit" }, overrideDir);

      // Fabricate a fully downloaded, valid 4-bit snapshot in the cache dir
      const cacheDir = path.join(overrideDir, "hf-cache");
      const repoFolder = path.join(cacheDir, "models--mlx-community--CLM-v0.1-8B-MLX-4bit");
      const sha = "d".repeat(40);
      const content = "{\"model_type\": \"clm\"}\n";
      const size = Buffer.byteLength(content);
      const oid = crypto.createHash("sha1").update(`blob ${size}\0${content}`).digest("hex");
      const snapshotDir = path.join(repoFolder, "snapshots", sha);
      await fsp.mkdir(snapshotDir, { recursive: true });
      await fsp.writeFile(path.join(snapshotDir, "config.json"), content, "utf-8");
      await fsp.writeFile(
        path.join(snapshotDir, MANIFEST_FILENAME),
        JSON.stringify({
          repo: "mlx-community/CLM-v0.1-8B-MLX-4bit",
          commitSha: sha,
          files: [{ path: "config.json", size, oid }],
          totalBytes: size,
          downloadedAt: new Date().toISOString(),
        }),
        "utf-8"
      );
      await fsp.mkdir(path.join(repoFolder, "refs"), { recursive: true });
      await fsp.writeFile(path.join(repoFolder, "refs", "main"), sha, "utf-8");

      const sessionHandlers: Record<string, any> = {};
      const commands: Record<string, any> = {};
      const mockPi = makeCommandPi(commands, sessionHandlers);
      // Embedder pins the 8-bit repo while a 4-bit choice is saved
      await registerPlugin(mockPi, {
        modelOptions: { repo: "mlx-community/CLM-v0.1-8B-MLX-8bit", cacheDir },
        statusTracker: new ClmStatusTracker(),
      });

      // One clear notice about the override, and no misleading first-use notice
      const notices: string[] = [];
      await emitSessionStart(sessionHandlers, notices);
      assert.ok(
        notices.some((n) => n.includes("overrides the registered modelOptions.repo (mlx-community/CLM-v0.1-8B-MLX-8bit)")),
        notices.join("\n")
      );
      assert.ok(notices.some((n) => n.includes("mlx-community/CLM-v0.1-8B-MLX-4bit")));
      assert.ok(!notices.some((n) => n.includes("no model variant chosen yet")));

      notices.length = 0;
      await emitSessionStart(sessionHandlers, notices);
      assert.equal(notices.length, 0);

      // Status resolves the saved 4-bit repo (present in the cache dir), not the pinned 8-bit one
      const statusNotices: string[] = [];
      const ctx: any = makeConfigureCtx((m: string) => statusNotices.push(m), async () => undefined);
      await commands["clm"].handler("status", ctx);
      assert.ok(
        statusNotices.includes("CLM: model downloaded"),
        statusNotices.join("\n")
      );
      assert.ok(!statusNotices.includes("CLM: model not downloaded"));
    } finally {
      if (prevEnv === undefined) delete process.env.PI_CLM_STATE_DIR;
      else process.env.PI_CLM_STATE_DIR = prevEnv;
      await fsp.rm(overrideDir, { recursive: true, force: true });
    }
  });

});

