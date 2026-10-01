import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import {
  getHubCacheDir,
  getRepoFolderPath,
  getModelPath,
  getRevisionSha,
  status,
  download,
  cleanup,
  DEFAULT_REPO,
  DEFAULT_REVISION,
  MANIFEST_FILENAME,
  type ProgressReport,
} from "../src/model-manager.ts";

const MOCK_COMMIT_SHA = "c".repeat(40);

interface MockHfFile {
  path: string;
  size: number;
  oid: string;
  sha256?: string;
  content: string;
}

function mockGitFile(filePath: string, content: string): MockHfFile {
  const size = Buffer.byteLength(content);
  const oid = crypto.createHash("sha1").update(`blob ${size}\0${content}`).digest("hex");
  return { path: filePath, size, oid, content };
}

function mockLfsFile(filePath: string, content: string): MockHfFile {
  const size = Buffer.byteLength(content);
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  return { path: filePath, size, oid: "dummyoid", sha256, content };
}

/** Mock HuggingFace hub API serving a repo tree and file resolve endpoints. */
async function startMockHfServer(files: MockHfFile[]) {
  let resolveHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.includes("/revision/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sha: MOCK_COMMIT_SHA }));
      return;
    }
    if (url.pathname.includes("/tree/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(files.map((f) => ({
        type: "file",
        oid: f.oid,
        size: f.size,
        path: f.path,
        ...(f.sha256 ? { lfs: { oid: f.sha256, size: f.size, pointerSize: 130 } } : {}),
      }))));
      return;
    }
    const file = files.find((f) => url.pathname.endsWith(f.path));
    if (file) {
      resolveHits++;
      res.setHeader("Content-Type", file.path.endsWith(".json") ? "application/json" : "application/octet-stream");
      res.end(file.content);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    resolveHits: () => resolveHits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("model-manager test suite", async (t) => {
  const tmpDir = path.join(os.tmpdir(), `pi-clm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpDir, { recursive: true });

  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  await t.test("getHubCacheDir follows standard HF hub cache resolution", () => {
    const envNames = ["HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_HOME", "XDG_CACHE_HOME"] as const;
    const saved = envNames.map((name) => [name, process.env[name]] as const);
    try {
      for (const name of envNames) delete process.env[name];

      process.env.HF_HUB_CACHE = "/custom/hf-hub-cache";
      assert.equal(getHubCacheDir(), "/custom/hf-hub-cache");

      delete process.env.HF_HUB_CACHE;
      process.env.HUGGINGFACE_HUB_CACHE = "/custom/legacy-hub-cache";
      assert.equal(getHubCacheDir(), "/custom/legacy-hub-cache");

      delete process.env.HUGGINGFACE_HUB_CACHE;
      process.env.HF_HOME = "/custom/hf-home";
      assert.equal(getHubCacheDir(), path.join("/custom/hf-home", "hub"));

      delete process.env.HF_HOME;
      process.env.XDG_CACHE_HOME = "/custom/xdg";
      assert.equal(getHubCacheDir(), path.join("/custom/xdg", "huggingface", "hub"));

      delete process.env.XDG_CACHE_HOME;
      assert.equal(getHubCacheDir(), path.join(os.homedir(), ".cache", "huggingface", "hub"));
    } finally {
      for (const [name, value] of saved) {
        if (value !== undefined) process.env[name] = value;
        else delete process.env[name];
      }
    }
  });

  await t.test("getRepoFolderPath uses standard models--org--repo folder name", () => {
    assert.equal(
      getRepoFolderPath({ cacheDir: tmpDir, repo: "test/repo" }),
      path.join(tmpDir, "models--test--repo")
    );
    assert.equal(
      getRepoFolderPath({ cacheDir: tmpDir }),
      path.join(tmpDir, "models--" + DEFAULT_REPO.replace(/\//g, "--"))
    );
  });

  await t.test("getModelPath resolves snapshot via refs and is provisional before download", async () => {
    const options = { cacheDir: tmpDir, repo: "refs/repo" };
    const repoFolder = getRepoFolderPath(options);

    // No refs yet: provisional path named after the revision
    assert.equal(getModelPath(options), path.join(repoFolder, "snapshots", DEFAULT_REVISION));

    // Write refs/main and re-resolve
    await fs.mkdir(path.join(repoFolder, "refs"), { recursive: true });
    await fs.writeFile(path.join(repoFolder, "refs", DEFAULT_REVISION), MOCK_COMMIT_SHA);
    assert.equal(getModelPath(options), path.join(repoFolder, "snapshots", MOCK_COMMIT_SHA));
    assert.equal(getRevisionSha(repoFolder, DEFAULT_REVISION), MOCK_COMMIT_SHA);
    assert.equal(getRevisionSha(repoFolder, "nonexistent-ref"), null);
  });

  await t.test("status reports missing when cache does not exist", async () => {
    const s = await status({ cacheDir: tmpDir, repo: "missing/repo" });
    assert.equal(s.cached, false);
    assert.equal(s.valid, false);
    assert.equal(s.filesCount, 0);
    assert.equal(s.totalBytes, 0);
  });

  await t.test("status reports invalid when snapshot exists without manifest", async () => {
    const options = { cacheDir: tmpDir, repo: "nomanifest/repo" };
    const repoFolder = getRepoFolderPath(options);
    const snapshotDir = path.join(repoFolder, "snapshots", MOCK_COMMIT_SHA);
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(path.join(snapshotDir, "config.json"), "{}");
    await fs.mkdir(path.join(repoFolder, "refs"), { recursive: true });
    await fs.writeFile(path.join(repoFolder, "refs", DEFAULT_REVISION), MOCK_COMMIT_SHA);

    const s = await status(options);
    assert.equal(s.cached, false);
    assert.equal(s.valid, false);
  });

  await t.test("cleanup removes stale downloads and incomplete files", async () => {
    const options = { cacheDir: tmpDir, repo: "cleanup/repo" };
    const repoFolder = getRepoFolderPath(options);
    const blobsDir = path.join(repoFolder, "blobs");
    await fs.mkdir(blobsDir, { recursive: true });
    const tmpIncomplete = path.join(blobsDir, "incomplete.tmp-123");
    await fs.writeFile(tmpIncomplete, "partial data");

    const removed = await cleanup(options);
    assert.ok(removed.includes(tmpIncomplete));
    const exists = await fs.stat(tmpIncomplete).then(() => true).catch(() => false);
    assert.equal(exists, false);

    // removeCurrent removes the whole models--org--repo folder
    const removedAll = await cleanup({ ...options, removeCurrent: true });
    assert.ok(removedAll.includes(repoFolder));
    const repoExists = await fs.stat(repoFolder).then(() => true).catch(() => false);
    assert.equal(repoExists, false);
  });

  await t.test("download populates standard HF hub cache layout with progress and validation", async () => {
    const file1 = mockGitFile("config.json", "{\"model_type\": \"qwen3\"}\n");
    const file2 = mockLfsFile("heads/CLM.safetensors", "weights-binary-data-simulation");

    const mockHf = await startMockHfServer([file1, file2]);

    try {
      const options = { cacheDir: tmpDir, hfEndpoint: mockHf.url, repo: "test/repo" };
      const repoFolder = getRepoFolderPath(options);

      const progressReports: ProgressReport[] = [];
      const downloadedDir = await download(options, (p) => progressReports.push(p));

      // Snapshot path for the resolved commit
      assert.equal(downloadedDir, path.join(repoFolder, "snapshots", MOCK_COMMIT_SHA));
      assert.ok(progressReports.length > 0);
      assert.equal(progressReports[progressReports.length - 1].percentage, 100);

      // refs/<revision> records the commit sha
      const refContent = await fs.readFile(path.join(repoFolder, "refs", DEFAULT_REVISION), "utf-8");
      assert.equal(refContent, MOCK_COMMIT_SHA);

      // Blobs are named by LFS sha256 / git blob oid
      const blobsDir = path.join(repoFolder, "blobs");
      const lfsStat = await fs.lstat(path.join(blobsDir, file2.sha256!));
      assert.ok(lfsStat.isFile());
      const gitStat = await fs.lstat(path.join(blobsDir, file1.oid));
      assert.ok(gitStat.isFile());

      // Snapshot files are relative symlinks into blobs
      const snap1 = path.join(downloadedDir, "config.json");
      assert.ok((await fs.lstat(snap1)).isSymbolicLink());
      assert.equal(await fs.readFile(snap1, "utf-8"), file1.content);

      const snap2 = path.join(downloadedDir, "heads", "CLM.safetensors");
      assert.ok((await fs.lstat(snap2)).isSymbolicLink());
      assert.equal(await fs.readFile(snap2, "utf-8"), file2.content);
      const real2 = await fs.realpath(snap2);
      assert.equal(real2, await fs.realpath(path.join(blobsDir, file2.sha256!)));

      // Manifest lives inside the snapshot
      const manifestStat = await fs.stat(path.join(downloadedDir, MANIFEST_FILENAME));
      assert.ok(manifestStat.isFile());

      // getModelPath resolves to the downloaded snapshot
      assert.equal(getModelPath(options), downloadedDir);

      // Verify status now reports valid
      const s = await status(options);
      assert.equal(s.valid, true);
      assert.equal(s.cached, true);
      assert.equal(s.modelDir, downloadedDir);
      assert.equal(s.filesCount, 2);
      assert.equal(s.totalBytes, file1.size + file2.size);

      // Second download call should skip downloading since status.valid is true
      let calledProgressAgain = false;
      const cachedDir = await download(options, () => { calledProgressAgain = true; });
      assert.equal(cachedDir, downloadedDir);
      assert.equal(calledProgressAgain, false);
    } finally {
      await mockHf.close();
    }
  });

  await t.test("status detects corrupted file with invalid checksum", async () => {
    // Corrupt the blob backing config.json (writing through the snapshot symlink)
    const targetFile = path.join(getModelPath({ cacheDir: tmpDir, repo: "test/repo" }), "config.json");
    await fs.writeFile(targetFile, JSON.stringify({ corrupted: true }));

    const s = await status({ cacheDir: tmpDir, repo: "test/repo" });
    assert.equal(s.valid, false);
    assert.equal(s.cached, false);
    assert.ok(s.invalidFiles.includes("config.json"));
  });

  await t.test("download adopts cache snapshots written by other HF tools without re-downloading", async () => {
    const adoptDir = path.join(tmpDir, "adopt");
    await fs.mkdir(adoptDir, { recursive: true });

    const file = mockGitFile("config.json", "{\"model_type\": \"qwen3\"}\n");

    // Simulate an externally downloaded cache (e.g. huggingface-cli):
    // refs + snapshot with real files, no pi-clm manifest
    const options = { cacheDir: adoptDir, repo: "ext/repo" };
    const repoFolder = getRepoFolderPath(options);
    const snapshotDir = path.join(repoFolder, "snapshots", MOCK_COMMIT_SHA);
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(path.join(snapshotDir, "config.json"), file.content);
    await fs.mkdir(path.join(repoFolder, "refs"), { recursive: true });
    await fs.writeFile(path.join(repoFolder, "refs", DEFAULT_REVISION), MOCK_COMMIT_SHA);

    const mockHf = await startMockHfServer([file]);

    try {
      const downloadedDir = await download({ ...options, hfEndpoint: mockHf.url });
      assert.equal(downloadedDir, snapshotDir);
      // No file was re-downloaded
      assert.equal(mockHf.resolveHits(), 0);

      const s = await status(options);
      assert.equal(s.valid, true);
      assert.equal(s.filesCount, 1);
    } finally {
      await mockHf.close();
    }
  });
});
