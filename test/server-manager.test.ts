import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import {
  ServerManager,
  isProcessRunning,
  getNativeServerBinPath,
  buildServerCommand,
  getPackageRoot,
} from "../src/server-manager.ts";

function createMockHealthServer(port: number, modelName = "clm-latest"): Promise<{ server: http.Server; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", model: modelName }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("ServerManager test suite", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-server-test-"));

  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  await t.test("checkHealth returns false when nothing is listening", async () => {
    const manager = new ServerManager({
      port: 59123,
      stateDir: tempDir,
    });
    const health = await manager.checkHealth();
    assert.equal(health.ok, false);
  });

  await t.test("checkHealth returns true and metadata when mock server responds", async () => {
    const port = 59124;
    const mock = await createMockHealthServer(port);

    try {
      const manager = new ServerManager({
        port,
        stateDir: tempDir,
      });
      const health = await manager.checkHealth();
      assert.equal(health.ok, true);
      assert.equal(health.status, "ok");
      assert.equal(health.model, "clm-latest");
    } finally {
      await mock.close();
    }
  });

  await t.test("lockfile management and refCount tracking across sessions", async () => {
    const port = 59125;
    const manager1 = new ServerManager({ port, stateDir: tempDir });
    const manager2 = new ServerManager({ port, stateDir: tempDir });
    const mock = await createMockHealthServer(port);

    try {
      const res1 = await manager1.start();
      assert.equal(res1.port, port);

      let lock = await manager1.readLockFile();
      assert.ok(lock);
      assert.equal(lock.refCount, 1);
      assert.deepEqual(lock.sessions, [manager1.getSessionId()]);

      const res2 = await manager2.start();
      assert.equal(res2.port, port);

      lock = await manager1.readLockFile();
      assert.ok(lock);
      assert.equal(lock.refCount, 2);
      assert.ok(lock.sessions.includes(manager1.getSessionId()));
      assert.ok(lock.sessions.includes(manager2.getSessionId()));

      // Session 1 stops - lockfile remains because session 2 is still active
      await manager1.stop();
      lock = await manager2.readLockFile();
      assert.ok(lock);
      assert.equal(lock.refCount, 1);
      assert.deepEqual(lock.sessions, [manager2.getSessionId()]);

      // Session 2 stops - lockfile is removed
      await manager2.stop();
      lock = await manager2.readLockFile();
      assert.equal(lock, null);
    } finally {
      await mock.close();
    }
  });

  await t.test("stale lockfile with dead PID is cleaned up", async () => {
    const manager = new ServerManager({ port: 59126, stateDir: tempDir });
    await manager.writeLockFile({
      pid: 99999999,
      port: 59126,
      host: "127.0.0.1",
      modelPath: "/fake/path",
      startedAt: new Date().toISOString(),
      refCount: 1,
      sessions: ["dead-session"],
    });

    const isRunning = await manager.isRunning();
    assert.equal(isRunning, false);
    const lock = await manager.readLockFile();
    assert.equal(lock, null);
  });

  await t.test("isProcessRunning accurately checks PID liveness", () => {
    assert.equal(isProcessRunning(process.pid), true);
    assert.equal(isProcessRunning(99999999), false);
  });

  await t.test("stateDir defaults to PI_CLM_STATE_DIR when set", () => {
    const original = process.env.PI_CLM_STATE_DIR;
    try {
      process.env.PI_CLM_STATE_DIR = path.join(tempDir, "state-override");
      const manager = new ServerManager({});
      assert.equal(manager.getStateDir(), path.join(tempDir, "state-override"));
      assert.equal(manager.getLockFilePath(), path.join(tempDir, "state-override", "server.lock"));
    } finally {
      if (original !== undefined) process.env.PI_CLM_STATE_DIR = original;
      else delete process.env.PI_CLM_STATE_DIR;
    }
  });

  await t.test("resolves model path to HF hub snapshot path", async () => {
    const hubDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-hub-test-"));
    const sha = "d".repeat(40);
    const repoFolder = path.join(hubDir, "models--test--repo");
    const manager = new ServerManager({
      port: 59127,
      stateDir: tempDir,
      hubCacheDir: hubDir,
      modelRepo: "test/repo",
    });

    // Nothing downloaded yet: provisional snapshot path named after the revision
    assert.equal(
      manager.getModelPath(),
      path.join(repoFolder, "snapshots", "main")
    );

    // Once refs/main exists, the same manager resolves the real snapshot (lazy)
    await fsp.mkdir(path.join(repoFolder, "refs"), { recursive: true });
    await fsp.writeFile(path.join(repoFolder, "refs", "main"), sha);
    assert.equal(
      manager.getModelPath(),
      path.join(repoFolder, "snapshots", sha)
    );

    // Explicit modelPath option takes precedence over HF cache resolution
    const explicit = new ServerManager({ stateDir: tempDir, modelPath: "/explicit/model/path" });
    assert.equal(explicit.getModelPath(), "/explicit/model/path");

    await fsp.rm(hubDir, { recursive: true, force: true });
  });
});

test("native server binary detection and preference", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-native-test-"));
  const originalEnv = process.env.PI_CLM_SERVER_BIN;

  const fakeBin = path.join(tempDir, "fake-clm-server");
  await fsp.writeFile(fakeBin, "#!/bin/sh\necho \"$@\" > \"$ARGS_OUT\"\nexec python3 \"$MOCK_SERVER\" \"$@\"\n", { mode: 0o755 });

  t.after(async () => {
    if (originalEnv !== undefined) process.env.PI_CLM_SERVER_BIN = originalEnv;
    else delete process.env.PI_CLM_SERVER_BIN;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Runs fn with PATH pointed at newPath and the packaged clm-server binary made
   * non-executable (as if absent), restoring the mode and PATH afterwards.
   * A null original mode means the binary is not present, so nothing is restored.
   */
  const withPackagedBinaryHidden = async (newPath: string, fn: () => void | Promise<void>) => {
    const packaged = path.join(getPackageRoot(), "bin", "clm-server");
    const originalPath = process.env.PATH;
    const originalMode = fs.existsSync(packaged) ? fs.statSync(packaged).mode : null;
    if (originalMode !== null) fs.chmodSync(packaged, 0o644);
    process.env.PATH = newPath;
    try {
      await fn();
    } finally {
      if (originalMode !== null) fs.chmodSync(packaged, originalMode);
      process.env.PATH = originalPath;
    }
  };

  await t.test("getNativeServerBinPath honors PI_CLM_SERVER_BIN override and disable", async () => {
    process.env.PI_CLM_SERVER_BIN = fakeBin;
    assert.equal(getNativeServerBinPath(), fakeBin);

    // non-executable / missing path falls back to null
    process.env.PI_CLM_SERVER_BIN = path.join(tempDir, "missing-bin");
    assert.equal(getNativeServerBinPath(), null);

    // empty string disables native serving entirely
    process.env.PI_CLM_SERVER_BIN = "";
    assert.equal(getNativeServerBinPath(), null);
  });

  await t.test("getNativeServerBinPath finds the packaged binary when enabled", async () => {
    delete process.env.PI_CLM_SERVER_BIN;
    await withPackagedBinaryHidden(tempDir, async () => {
      assert.equal(getNativeServerBinPath(), null);
    });
  });

  await t.test("getNativeServerBinPath falls back to pi-clm-server on PATH", async () => {
    delete process.env.PI_CLM_SERVER_BIN;
    const binDir = path.join(tempDir, "fake-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const onPath = path.join(binDir, "pi-clm-server");
    fs.writeFileSync(onPath, "#!/bin/sh\n", { mode: 0o755 });
    await withPackagedBinaryHidden(binDir, async () => {
      assert.equal(getNativeServerBinPath(), onPath);
    });
  });

  await t.test("buildServerCommand picks native for the 8-bit repo, uv for other variants", () => {
    const opts = {
      port: 8700,
      modelPath: "/m",
      truncation: "head",
      serverScriptPath: "/s.py",
      repo: "mlx-community/CLM-v0.1-8B-MLX-8bit",
    };

    process.env.PI_CLM_SERVER_BIN = fakeBin;
    const cmd = buildServerCommand(opts);
    assert.equal(cmd.native, true);
    assert.equal(cmd.command, fakeBin);
    assert.deepEqual(cmd.args, ["--port", "8700", "--model-path", "/m", "--truncation", "head"]);

    // the native binary loads only the 8-bit checkpoint: other variants — and
    // any repo when the native server is disabled — go through uv
    const fourBitWithNative = buildServerCommand({ ...opts, repo: "mlx-community/CLM-v0.1-8B-MLX-4bit" });
    process.env.PI_CLM_SERVER_BIN = "";
    const eightBitWithoutNative = buildServerCommand(opts);
    for (const uv of [fourBitWithNative, eightBitWithoutNative]) {
      assert.equal(uv.native, false);
      assert.equal(uv.command, "uv");
      assert.deepEqual(uv.args, ["run", "/s.py", "--port", "8700", "--model-path", "/m", "--truncation", "head"]);
    }
  });

  /**
   * Runs fn with the fake native binary selected (ARGS_OUT/MOCK_SERVER wired)
   * and a fresh state dir, restoring the env and removing the dir afterwards.
   */
  const withFakeNativeServer = async (
    fn: (env: { argsFile: string; stateDir: string }) => Promise<void>
  ) => {
    const argsFile = path.join(tempDir, `spawn-args-${Date.now()}.txt`);
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-native-state-"));
    process.env.PI_CLM_SERVER_BIN = fakeBin;
    process.env.ARGS_OUT = argsFile;
    process.env.MOCK_SERVER = path.resolve(process.cwd(), "test/fixtures/mock-server.py");
    try {
      await fn({ argsFile, stateDir });
    } finally {
      delete process.env.PI_CLM_SERVER_BIN;
      delete process.env.ARGS_OUT;
      delete process.env.MOCK_SERVER;
      await fsp.rm(stateDir, { recursive: true, force: true });
    }
  };

  await t.test("start() spawns the native binary and passes model path + port", async () => {
    const port = 59128;
    await withFakeNativeServer(async ({ argsFile, stateDir }) => {
      const manager = new ServerManager({
        port,
        stateDir,
        hubCacheDir: tempDir,
        modelRepo: "mlx-community/CLM-v0.1-8B-MLX-8bit",
        startupTimeoutMs: 30_000,
      });

      await manager.start();

      const lock = await manager.readLockFile();
      assert.ok(lock);
      assert.equal(lock.port, port);

      const spawnedArgs = (await fsp.readFile(argsFile, "utf-8")).trim().split(/\s+/);
      assert.ok(spawnedArgs.includes("--port"));
      assert.equal(spawnedArgs[spawnedArgs.indexOf("--port") + 1], String(port));
      assert.ok(spawnedArgs.includes("--model-path"));
      const modelPath = spawnedArgs[spawnedArgs.indexOf("--model-path") + 1];
      assert.ok(modelPath.includes("models--mlx-community--CLM-v0.1-8B-MLX-8bit"), modelPath);
      assert.ok(!spawnedArgs.includes("run"), "native spawn must not go through uv");

      await manager.stop();
    });
  });

  await t.test("start() serves non-8-bit repos through the Python fallback even with a native binary", async () => {
    const port = 59129;
    await withFakeNativeServer(async ({ argsFile, stateDir }) => {
      const manager = new ServerManager({
        port,
        stateDir,
        hubCacheDir: tempDir,
        modelRepo: "mlx-community/CLM-v0.1-8B-MLX-4bit",
        serverScriptPath: path.resolve(process.cwd(), "test/fixtures/mock-server.py"),
        startupTimeoutMs: 30_000,
      });

      await manager.start();

      // The native binary was never spawned...
      assert.equal(await fsp.stat(argsFile).catch(() => null), null);
      // ...the server still came up, through the Python fallback, on the 4-bit snapshot
      const health = await manager.checkHealth();
      assert.equal(health.ok, true);
      const lock = await manager.readLockFile();
      assert.ok(lock);
      assert.ok(lock.modelPath.includes("models--mlx-community--CLM-v0.1-8B-MLX-4bit"), lock.modelPath);

      await manager.stop();
    });
  });
});
