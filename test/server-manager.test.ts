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
      // Session 1 attaches
      const res1 = await manager1.start();
      assert.equal(res1.port, port);

      let lock = await manager1.readLockFile();
      assert.ok(lock);
      assert.equal(lock.refCount, 1);
      assert.deepEqual(lock.sessions, [manager1.getSessionId()]);

      // Session 2 attaches
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
    // Write fake lockfile with dead PID
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
    // Lockfile should be cleaned up
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

  await t.test("getNativeServerBinPath finds the packaged binary when enabled", () => {
    delete process.env.PI_CLM_SERVER_BIN;
    const packaged = path.join(getPackageRoot(), "bin", "clm-server");
    const originalPath = process.env.PATH;
    const originalMode = fs.existsSync(packaged) ? fs.statSync(packaged).mode : null;
    if (originalMode !== null) fs.chmodSync(packaged, 0o644);
    process.env.PATH = tempDir;
    try {
      assert.equal(getNativeServerBinPath(), null);
    } finally {
      if (originalMode !== null) fs.chmodSync(packaged, originalMode);
      process.env.PATH = originalPath;
    }
  });

  await t.test("getNativeServerBinPath falls back to pi-clm-server on PATH", () => {
    delete process.env.PI_CLM_SERVER_BIN;
    const binDir = path.join(tempDir, "fake-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const onPath = path.join(binDir, "pi-clm-server");
    fs.writeFileSync(onPath, "#!/bin/sh\n", { mode: 0o755 });
    const packaged = path.join(getPackageRoot(), "bin", "clm-server");
    const originalPath = process.env.PATH;
    const originalMode = fs.existsSync(packaged) ? fs.statSync(packaged).mode : null;
    if (originalMode !== null) fs.chmodSync(packaged, 0o644);
    process.env.PATH = binDir;
    try {
      assert.equal(getNativeServerBinPath(), onPath);
    } finally {
      if (originalMode !== null) fs.chmodSync(packaged, originalMode);
      process.env.PATH = originalPath;
    }
  });

  await t.test("buildServerCommand prefers native, falls back to uv", () => {
    const opts = { port: 8700, modelPath: "/m", truncation: "head", serverScriptPath: "/s.py" };

    process.env.PI_CLM_SERVER_BIN = fakeBin;
    let cmd = buildServerCommand(opts);
    assert.equal(cmd.native, true);
    assert.equal(cmd.command, fakeBin);
    assert.deepEqual(cmd.args, ["--port", "8700", "--model-path", "/m", "--truncation", "head"]);

    process.env.PI_CLM_SERVER_BIN = "";
    cmd = buildServerCommand(opts);
    assert.equal(cmd.native, false);
    assert.equal(cmd.command, "uv");
    assert.deepEqual(cmd.args, ["run", "/s.py", "--port", "8700", "--model-path", "/m", "--truncation", "head"]);
  });

  await t.test("start() spawns the native binary and passes model path + port", async () => {
    const port = 59128;
    const argsFile = path.join(tempDir, "spawn-args.txt");
    const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-clm-native-state-"));
    const manager = new ServerManager({
      port,
      stateDir,
      hubCacheDir: tempDir,
      modelRepo: "test/repo",
      startupTimeoutMs: 30_000,
    });

    process.env.PI_CLM_SERVER_BIN = fakeBin;
    process.env.ARGS_OUT = argsFile;
    process.env.MOCK_SERVER = path.resolve(process.cwd(), "test/fixtures/mock-server.py");
    try {
      await manager.start();

      const lock = await manager.readLockFile();
      assert.ok(lock);
      assert.equal(lock.port, port);

      const spawnedArgs = (await fsp.readFile(argsFile, "utf-8")).trim().split(/\s+/);
      assert.ok(spawnedArgs.includes("--port"));
      assert.equal(spawnedArgs[spawnedArgs.indexOf("--port") + 1], String(port));
      assert.ok(spawnedArgs.includes("--model-path"));
      const modelPath = spawnedArgs[spawnedArgs.indexOf("--model-path") + 1];
      assert.ok(modelPath.includes("models--test--repo"), modelPath);
      assert.ok(!spawnedArgs.includes("run"), "native spawn must not go through uv");

      await manager.stop();
    } finally {
      delete process.env.PI_CLM_SERVER_BIN;
      delete process.env.ARGS_OUT;
      delete process.env.MOCK_SERVER;
      await fsp.rm(stateDir, { recursive: true, force: true });
    }
  });
});
