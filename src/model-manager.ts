import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getHFHubCachePath, getRepoFolderName } from "@huggingface/hub";

export const DEFAULT_REPO = "mlx-community/CLM-v0.1-8B-MLX-8bit";
export const DEFAULT_REVISION = "main";
export const MANIFEST_FILENAME = ".pi-clm-manifest.json";

export interface ProgressReport {
  file: string;
  fileIndex: number;
  totalFiles: number;
  bytesDownloaded: number;
  totalBytes: number;
  fileBytesDownloaded: number;
  fileTotalBytes: number;
  percentage: number;
  etaSeconds: number | null;
  speedBytesPerSec: number;
}

export interface ModelManagerOptions {
  repo?: string;
  revision?: string;
  cacheDir?: string;
  hfEndpoint?: string;
  hfToken?: string;
}

export interface ModelStatus {
  cached: boolean;
  valid: boolean;
  modelDir: string;
  filesCount: number;
  totalBytes: number;
  missingFiles: string[];
  invalidFiles: string[];
}

export interface ManifestFileEntry {
  path: string;
  size: number;
  sha256?: string;
  oid?: string;
}

export interface ModelManifest {
  repo: string;
  commitSha: string;
  files: ManifestFileEntry[];
  totalBytes: number;
  downloadedAt: string;
}

interface HFTreeItem {
  type: "file" | "directory";
  oid: string;
  size: number;
  path: string;
  lfs?: {
    oid: string;
    size: number;
    pointerSize: number;
  };
}

/**
 * Root of the Hugging Face hub cache.
 *
 * Uses the standard resolution from `@huggingface/hub`:
 * `HF_HUB_CACHE` > `HUGGINGFACE_HUB_CACHE` > `HF_HOME/hub` >
 * `XDG_CACHE_HOME/huggingface/hub` > `~/.cache/huggingface/hub`.
 * An explicit `cacheDir` option wins for tests/embedders.
 */
export function getHubCacheDir(options?: ModelManagerOptions): string {
  return options?.cacheDir ?? getHFHubCachePath();
}

/**
 * Repository folder in standard hub cache layout: `models--<org>--<repo>`.
 */
export function getRepoFolderPath(options?: ModelManagerOptions): string {
  const repo = options?.repo ?? DEFAULT_REPO;
  return path.join(getHubCacheDir(options), getRepoFolderName({ name: repo, type: "model" }));
}

/**
 * Commit sha recorded under `refs/<revision>`, or null when absent.
 */
export function getRevisionSha(repoFolder: string, revision: string = DEFAULT_REVISION): string | null {
  try {
    const sha = fs.readFileSync(path.join(repoFolder, "refs", revision), "utf-8").trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the model snapshot directory (`snapshots/<commit-sha>`).
 *
 * Reads `refs/<revision>` to find the pinned commit. Before the first
 * download the ref does not exist yet; in that case a provisional path
 * named after the revision is returned.
 */
export function getModelPath(options?: ModelManagerOptions): string {
  const repoFolder = getRepoFolderPath(options);
  const revision = options?.revision ?? DEFAULT_REVISION;
  const sha = getRevisionSha(repoFolder, revision);
  return path.join(repoFolder, "snapshots", sha ?? revision);
}

/** Blob file name used by the hub cache: LFS sha256, otherwise the git blob oid. */
function getBlobName(file: ManifestFileEntry): string {
  return file.sha256 ?? file.oid!;
}

async function computeHashFromStream(filePath: string, hash: crypto.Hash): Promise<string> {
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function computeFileSha256(filePath: string): Promise<string> {
  return computeHashFromStream(filePath, crypto.createHash("sha256"));
}

async function computeGitBlobOid(filePath: string): Promise<string> {
  const stat = await fsp.stat(filePath);
  const hash = crypto.createHash("sha1");
  hash.update(`blob ${stat.size}\0`);
  return computeHashFromStream(filePath, hash);
}

async function verifyFileIntegrity(filePath: string, expected: { size: number; sha256?: string; oid?: string }): Promise<boolean> {
  try {
    // stat (not lstat): snapshot entries are symlinks into blobs, the
    // underlying blob content is what gets verified.
    const stat = await fsp.stat(filePath);
    if (stat.size !== expected.size) return false;
    if (expected.sha256) {
      const actualSha = await computeFileSha256(filePath);
      return actualSha === expected.sha256;
    }
    if (expected.oid) {
      const actualOid = await computeGitBlobOid(filePath);
      return actualOid === expected.oid;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchRepoTree(
  repo: string,
  revision: string,
  endpoint: string,
  token?: string
): Promise<{ files: ManifestFileEntry[]; commitSha: string }> {
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Resolve the revision to its pinned commit sha
  const infoRes = await fetch(`${endpoint}/api/models/${repo}/revision/${revision}`, { headers });
  if (!infoRes.ok) {
    throw new Error(`Failed to fetch model revision info from HuggingFace (${infoRes.status} ${infoRes.statusText})`);
  }
  const info = (await infoRes.json()) as { sha?: string };
  const commitSha = info.sha ?? "";
  if (!commitSha) {
    throw new Error(`HuggingFace did not return a commit sha for ${repo}@${revision}`);
  }

  const url = `${endpoint}/api/models/${repo}/tree/${revision}?recursive=true`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch model repository tree from HuggingFace (${res.status} ${res.statusText})`);
  }

  const treeItems = (await res.json()) as HFTreeItem[];

  const files: ManifestFileEntry[] = [];
  for (const item of treeItems) {
    if (item.type !== "file") continue;
    if (item.path === ".gitattributes") continue;

    files.push({
      path: item.path,
      size: item.lfs ? item.lfs.size : item.size,
      sha256: item.lfs ? item.lfs.oid : undefined,
      oid: item.oid,
    });
  }

  return { files, commitSha };
}

/**
 * Link a snapshot entry to its blob with a relative symlink, matching the
 * hub cache standard. Falls back to copying the file when symlinks are not
 * supported by the platform.
 */
async function linkSnapshotEntry(blobPath: string, pointerPath: string): Promise<void> {
  await fsp.rm(pointerPath, { force: true });
  await fsp.mkdir(path.dirname(pointerPath), { recursive: true });
  try {
    await fsp.symlink(path.relative(path.dirname(pointerPath), blobPath), pointerPath);
  } catch {
    await fsp.copyFile(blobPath, pointerPath);
  }
}

async function writeRevisionRef(repoFolder: string, revision: string, commitSha: string): Promise<void> {
  const refsDir = path.join(repoFolder, "refs");
  await fsp.mkdir(refsDir, { recursive: true });
  const refPath = path.join(refsDir, revision);
  const tempPath = `${refPath}.tmp-${Date.now()}`;
  await fsp.writeFile(tempPath, commitSha, "utf-8");
  await fsp.rename(tempPath, refPath);
}

export async function status(options?: ModelManagerOptions): Promise<ModelStatus> {
  const repoFolder = getRepoFolderPath(options);
  const revision = options?.revision ?? DEFAULT_REVISION;
  const modelDir = getModelPath(options);
  const commitSha = getRevisionSha(repoFolder, revision);

  if (!commitSha) {
    return {
      cached: false,
      valid: false,
      modelDir,
      filesCount: 0,
      totalBytes: 0,
      missingFiles: [],
      invalidFiles: [],
    };
  }

  const manifestPath = path.join(modelDir, MANIFEST_FILENAME);

  try {
    const manifestRaw = await fsp.readFile(manifestPath, "utf-8");
    const manifest: ModelManifest = JSON.parse(manifestRaw);

    const missingFiles: string[] = [];
    const invalidFiles: string[] = [];
    let filesCount = 0;
    let totalBytes = 0;

    for (const file of manifest.files) {
      const fullPath = path.join(modelDir, file.path);
      try {
        const exists = await fsp.stat(fullPath).then(() => true).catch(() => false);
        if (!exists) {
          missingFiles.push(file.path);
          continue;
        }

        const valid = await verifyFileIntegrity(fullPath, file);
        if (!valid) {
          invalidFiles.push(file.path);
          continue;
        }

        filesCount++;
        totalBytes += file.size;
      } catch {
        missingFiles.push(file.path);
      }
    }

    const isValid = missingFiles.length === 0 && invalidFiles.length === 0 && manifest.files.length > 0;
    return {
      cached: isValid,
      valid: isValid,
      modelDir,
      filesCount,
      totalBytes,
      missingFiles,
      invalidFiles,
    };
  } catch {
    return {
      cached: false,
      valid: false,
      modelDir,
      filesCount: 0,
      totalBytes: 0,
      missingFiles: [],
      invalidFiles: [],
    };
  }
}

export async function download(
  options?: ModelManagerOptions,
  onProgress?: (progress: ProgressReport) => void
): Promise<string> {
  const repo = options?.repo ?? DEFAULT_REPO;
  const revision = options?.revision ?? DEFAULT_REVISION;
  const endpoint = (options?.hfEndpoint ?? "https://huggingface.co").replace(/\/$/, "");
  const token = options?.hfToken ?? process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  const repoFolder = getRepoFolderPath(options);

  const currentStatus = await status(options);
  if (currentStatus.valid) {
    return currentStatus.modelDir;
  }

  const { files, commitSha } = await fetchRepoTree(repo, revision, endpoint, token);
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  const snapshotDir = path.join(repoFolder, "snapshots", commitSha);
  const blobsDir = path.join(repoFolder, "blobs");
  await fsp.mkdir(blobsDir, { recursive: true });

  let overallBytesDownloaded = 0;
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pointerPath = path.join(snapshotDir, file.path);
    const blobPath = path.join(blobsDir, getBlobName(file));

    // Snapshot entry already present and valid (downloaded by us or another
    // HF tool): reuse it as-is.
    if (await verifyFileIntegrity(pointerPath, file)) {
      overallBytesDownloaded += file.size;
      continue;
    }

    // Stale snapshot entry (e.g. dangling symlink): drop before relinking
    await fsp.rm(pointerPath, { force: true });

    // Blob already present (e.g. shared with another revision): link it
    if (!(await verifyFileIntegrity(blobPath, file))) {
      const fileUrl = `${endpoint}/${repo}/resolve/${revision}/${file.path}`;
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(fileUrl, { headers });
      if (!res.ok || !res.body) {
        throw new Error(`Failed to download ${file.path}: ${res.status} ${res.statusText}`);
      }

      const tempPath = `${blobPath}.tmp-${Date.now()}`;
      const writeStream = fs.createWriteStream(tempPath);

      let fileBytesDownloaded = 0;
      const bodyStream = Readable.fromWeb(res.body as any);

      bodyStream.on("data", (chunk: Buffer) => {
        fileBytesDownloaded += chunk.length;
        overallBytesDownloaded += chunk.length;

        if (onProgress) {
          const elapsed = (Date.now() - startTime) / 1000;
          const speedBytesPerSec = elapsed > 0 ? overallBytesDownloaded / elapsed : 0;
          const remainingBytes = Math.max(0, totalBytes - overallBytesDownloaded);
          const etaSeconds = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : null;
          const percentage = totalBytes > 0 ? (overallBytesDownloaded / totalBytes) * 100 : 100;

          onProgress({
            file: file.path,
            fileIndex: i,
            totalFiles: files.length,
            bytesDownloaded: overallBytesDownloaded,
            totalBytes,
            fileBytesDownloaded,
            fileTotalBytes: file.size,
            percentage,
            etaSeconds,
            speedBytesPerSec,
          });
        }
      });

      await pipeline(bodyStream, writeStream);

      const valid = await verifyFileIntegrity(tempPath, file);
      if (!valid) {
        await fsp.unlink(tempPath).catch(() => {});
        throw new Error(`Integrity verification failed for ${file.path}`);
      }

      await fsp.rename(tempPath, blobPath);
    }

    await linkSnapshotEntry(blobPath, pointerPath);
  }

  const manifest: ModelManifest = {
    repo,
    commitSha,
    files,
    totalBytes,
    downloadedAt: new Date().toISOString(),
  };
  await fsp.mkdir(snapshotDir, { recursive: true });
  await fsp.writeFile(path.join(snapshotDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), "utf-8");

  // Pin the revision to this commit, matching hub cache refs layout
  await writeRevisionRef(repoFolder, revision, commitSha);

  return snapshotDir;
}

export async function cleanup(options?: ModelManagerOptions & { removeCurrent?: boolean }): Promise<string[]> {
  const repoFolder = getRepoFolderPath(options);
  const removed: string[] = [];

  try {
    const entries = await fsp.readdir(repoFolder, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(entry.parentPath ?? repoFolder, entry.name);
        if (entry.name.includes(".tmp") || entry.name.endsWith(".incomplete")) {
          await fsp.unlink(fullPath).catch(() => {});
          removed.push(fullPath);
        }
      }
    }
  } catch {
    // Model directory might not exist
  }

  if (options?.removeCurrent) {
    try {
      await fsp.rm(repoFolder, { recursive: true, force: true });
      removed.push(repoFolder);
    } catch {
    }
  }

  return removed;
}
