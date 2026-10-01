import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import {
  getModelPath,
  status,
  download,
  cleanup,
  getCacheDir,
  DEFAULT_REPO,
  type ProgressReport,
} from "../src/model-manager.ts";

test("model-manager test suite", async (t) => {
  const tmpDir = path.join(os.tmpdir(), `pi-clm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await t.test("getCacheDir respects PI_CLM_CACHE_DIR and XDG_CACHE_HOME", () => {
    const originalPiCache = process.env.PI_CLM_CACHE_DIR;
    const originalXdg = process.env.XDG_CACHE_HOME;
    try {
      process.env.PI_CLM_CACHE_DIR = "/custom/pi/cache";
      assert.equal(getCacheDir(), "/custom/pi/cache");

      delete process.env.PI_CLM_CACHE_DIR;
      process.env.XDG_CACHE_HOME = "/custom/xdg/cache";
      assert.equal(getCacheDir(), path.join("/custom/xdg/cache", "pi-clm"));

      delete process.env.XDG_CACHE_HOME;
      assert.equal(getCacheDir(), path.join(os.homedir(), ".cache", "pi-clm"));
    } finally {
      if (originalPiCache !== undefined) process.env.PI_CLM_CACHE_DIR = originalPiCache;
      else delete process.env.PI_CLM_CACHE_DIR;
      if (originalXdg !== undefined) process.env.XDG_CACHE_HOME = originalXdg;
      else delete process.env.XDG_CACHE_HOME;
    }
  });

  await t.test("getModelPath returns model directory under cache dir", () => {
    const modelPath = getModelPath({ cacheDir: tmpDir });
    assert.equal(modelPath, path.join(tmpDir, "models", DEFAULT_REPO.replace("/", "--")));
  });

  await t.test("status reports missing when directory does not exist", async () => {
    const s = await status({ cacheDir: tmpDir });
    assert.equal(s.cached, false);
    assert.equal(s.valid, false);
    assert.equal(s.filesCount, 0);
    assert.equal(s.totalBytes, 0);
  });

  await t.test("status reports invalid when files are missing or incomplete", async () => {
    const modelDir = getModelPath({ cacheDir: tmpDir });
    await fs.mkdir(modelDir, { recursive: true });
    // Write just one file without manifest
    await fs.writeFile(path.join(modelDir, "config.json"), "{}");

    const s = await status({ cacheDir: tmpDir });
    assert.equal(s.cached, false);
    assert.equal(s.valid, false);
  });

  await t.test("cleanup removes stale downloads and incomplete files", async () => {
    const modelDir = getModelPath({ cacheDir: tmpDir });
    await fs.mkdir(modelDir, { recursive: true });
    const tmpIncomplete = path.join(modelDir, "incomplete.tmp");
    await fs.writeFile(tmpIncomplete, "partial data");

    const removed = await cleanup({ cacheDir: tmpDir, removeCurrent: false });
    assert.ok(removed.includes(tmpIncomplete));
    const exists = await fs.stat(tmpIncomplete).then(() => true).catch(() => false);
    assert.equal(exists, false);
  });

  await t.test("download downloads files from HuggingFace mock server with progress and validation", async () => {
    const file1Content = "{\"model_type\": \"qwen3\"}\n";
    const file1Size = Buffer.byteLength(file1Content);
    const file1Oid = crypto.createHash("sha1").update(`blob ${file1Size}\0${file1Content}`).digest("hex");

    const file2Content = "weights-binary-data-simulation";
    const file2Size = Buffer.byteLength(file2Content);
    const file2Sha256 = crypto.createHash("sha256").update(file2Content).digest("hex");

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (url.pathname.includes("/tree/main")) {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("x-repo-commit", "mockcommit123");
        res.end(JSON.stringify([
          {
            type: "file",
            oid: file1Oid,
            size: file1Size,
            path: "config.json"
          },
          {
            type: "file",
            oid: "dummyoid",
            size: file2Size,
            path: "heads/CLM.safetensors",
            lfs: {
              oid: file2Sha256,
              size: file2Size,
              pointerSize: 130
            }
          }
        ]));
        return;
      }

      if (url.pathname.endsWith("config.json")) {
        res.setHeader("Content-Type", "application/json");
        res.end(file1Content);
        return;
      }

      if (url.pathname.endsWith("CLM.safetensors")) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(file2Content);
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const hfEndpoint = `http://127.0.0.1:${port}`;

    try {
      const progressReports: ProgressReport[] = [];
      const downloadedDir = await download(
        { cacheDir: tmpDir, hfEndpoint, repo: "test/repo" },
        (p) => progressReports.push(p)
      );

      assert.equal(downloadedDir, getModelPath({ cacheDir: tmpDir, repo: "test/repo" }));
      assert.ok(progressReports.length > 0);
      const lastProgress = progressReports[progressReports.length - 1];
      assert.equal(lastProgress.percentage, 100);

      // Verify status now reports valid
      const s = await status({ cacheDir: tmpDir, repo: "test/repo" });
      assert.equal(s.valid, true);
      assert.equal(s.cached, true);
      assert.equal(s.filesCount, 2);
      assert.equal(s.totalBytes, file1Size + file2Size);

      // Second download call should skip downloading since status.valid is true
      let calledProgressAgain = false;
      const cachedDir = await download(
        { cacheDir: tmpDir, hfEndpoint, repo: "test/repo" },
        () => { calledProgressAgain = true; }
      );
      assert.equal(cachedDir, downloadedDir);
      assert.equal(calledProgressAgain, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await t.test("status detects corrupted file with invalid checksum", async () => {
    // Corrupt one file in test/repo
    const targetFile = path.join(getModelPath({ cacheDir: tmpDir, repo: "test/repo" }), "config.json");
    await fs.writeFile(targetFile, JSON.stringify({ corrupted: true }));

    const s = await status({ cacheDir: tmpDir, repo: "test/repo" });
    assert.equal(s.valid, false);
    assert.equal(s.cached, false);
    assert.ok(s.invalidFiles.includes("config.json"));
  });
});
