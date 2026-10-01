import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { ServerManager, isProcessRunning } from "../src/server-manager.ts";

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
      cacheDir: tempDir,
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
        cacheDir: tempDir,
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
    const manager1 = new ServerManager({ port, cacheDir: tempDir });
    const manager2 = new ServerManager({ port, cacheDir: tempDir });
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
    const manager = new ServerManager({ port: 59126, cacheDir: tempDir });
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
});
