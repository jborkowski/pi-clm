import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_REPO = "mlx-community/CLM-v0.1-8B-MLX-8bit";
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

export function getCacheDir(): string {
  if (process.env.PI_CLM_CACHE_DIR) {
    return process.env.PI_CLM_CACHE_DIR;
  }
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "pi-clm");
  }
  return path.join(os.homedir(), ".cache", "pi-clm");
}

export function getModelPath(options?: ModelManagerOptions): string {
  const cacheDir = options?.cacheDir ?? getCacheDir();
  const repo = options?.repo ?? DEFAULT_REPO;
  const repoDirName = repo.replace(/\//g, "--");
  return path.join(cacheDir, "models", repoDirName);
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
  endpoint: string,
  token?: string
): Promise<{ files: ManifestFileEntry[]; commitSha: string }> {
  const url = `${endpoint}/api/models/${repo}/tree/main?recursive=true`;
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch model repository tree from HuggingFace (${res.status} ${res.statusText})`);
  }

  const commitSha = res.headers.get("x-repo-commit") || "";
  const treeItems = (await res.json()) as HFTreeItem[];

  const files: ManifestFileEntry[] = [];
  for (const item of treeItems) {
    if (item.type !== "file") continue;
    // Skip git repository attributes
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

export async function status(options?: ModelManagerOptions): Promise<ModelStatus> {
  const modelDir = getModelPath(options);
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
  const endpoint = (options?.hfEndpoint ?? "https://huggingface.co").replace(/\/$/, "");
  const token = options?.hfToken ?? process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  const modelDir = getModelPath(options);

  // Check if existing cache is fully valid
  const currentStatus = await status(options);
  if (currentStatus.valid) {
    return modelDir;
  }

  await fsp.mkdir(modelDir, { recursive: true });

  const { files, commitSha } = await fetchRepoTree(repo, endpoint, token);
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  let overallBytesDownloaded = 0;
  const startTime = Date.now();

  const manifestPath = path.join(modelDir, MANIFEST_FILENAME);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fullPath = path.join(modelDir, file.path);
    const parentDir = path.dirname(fullPath);
    await fsp.mkdir(parentDir, { recursive: true });

    // Check if valid already on disk
    if (await verifyFileIntegrity(fullPath, file)) {
      overallBytesDownloaded += file.size;
      continue;
    }

    // Download file
    const fileUrl = `${endpoint}/${repo}/resolve/main/${file.path}`;
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(fileUrl, { headers });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download ${file.path}: ${res.status} ${res.statusText}`);
    }

    const tempPath = `${fullPath}.tmp-${Date.now()}`;
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

    // Validate downloaded file
    const valid = await verifyFileIntegrity(tempPath, file);
    if (!valid) {
      await fsp.unlink(tempPath).catch(() => {});
      throw new Error(`Integrity verification failed for ${file.path}`);
    }

    await fsp.rename(tempPath, fullPath);
  }

  // Write manifest
  const manifest: ModelManifest = {
    repo,
    commitSha,
    files,
    totalBytes,
    downloadedAt: new Date().toISOString(),
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  return modelDir;
}

export async function cleanup(options?: ModelManagerOptions & { removeCurrent?: boolean }): Promise<string[]> {
  const modelDir = getModelPath(options);
  const removed: string[] = [];

  try {
    const entries = await fsp.readdir(modelDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(entry.parentPath ?? modelDir, entry.name);
        if (entry.name.includes(".tmp") || entry.name.endsWith(".tmp")) {
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
      await fsp.rm(modelDir, { recursive: true, force: true });
      removed.push(modelDir);
    } catch {
      // Ignore
    }
  }

  return removed;
}
