import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REPO,
  getHubCacheDir,
  getModelPath as resolveHubModelPath,
  type ModelManagerOptions,
} from "./model-manager.ts";

export const DEFAULT_PORT = 8700;
export const DEFAULT_HOST = "127.0.0.1";
export const LOCK_FILENAME = "server.lock";
export const LOG_FILENAME = "server.log";

export interface ServerManagerOptions {
  port?: number;
  host?: string;
  /** Explicit model path; overrides HF hub cache resolution. */
  modelPath?: string;
  /** Hugging Face repo id used to resolve the model snapshot (default: DEFAULT_REPO). */
  modelRepo?: string;
  /** Overrides the HF hub cache root (default: standard HF_HUB_CACHE / HF_HOME / ~/.cache/huggingface/hub). */
  hubCacheDir?: string;
  /** Directory for the lock file and server log. */
  stateDir?: string;
  serverScriptPath?: string;
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  truncation?: "head" | "tail";
  logPath?: string;
}

/** Options with defaults applied; model path resolution stays lazy. */
export type ResolvedServerManagerOptions = Required<Omit<ServerManagerOptions, "modelPath" | "modelRepo" | "hubCacheDir">> &
  Pick<ServerManagerOptions, "modelPath" | "modelRepo" | "hubCacheDir">;

export interface ServerLockInfo {
  pid: number;
  port: number;
  host: string;
  modelPath: string;
  startedAt: string;
  refCount: number;
  sessions: string[];
}

export interface ServerHealthStatus {
  ok: boolean;
  status?: string;
  model?: string;
  error?: string;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

/** Directory for pi-clm runtime state (lock file, server log). */
export function getDefaultStateDir(): string {
  if (process.env.PI_CLM_STATE_DIR) {
    return process.env.PI_CLM_STATE_DIR;
  }
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "pi-clm");
  }
  return path.join(os.homedir(), ".cache", "pi-clm");
}

export function getDefaultServerScriptPath(): string {
  // If running in ES module
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.resolve(currentDir, "../server/server.py");
  if (fs.existsSync(serverPath)) {
    return serverPath;
  }
  // Fallback to local server dir if running from root
  return path.resolve(process.cwd(), "server/server.py");
}

/** Package root (the directory containing bin/, server/, src/). */
export function getPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Path of the pre-compiled native clm-server binary, or null when it should
 * not be used:
 * - `PI_CLM_SERVER_BIN` set to a path -> that path (empty string disables
 *   the native server, forcing the `uv run server.py` fallback);
 * - otherwise `<package root>/bin/clm-server` when present and executable;
 * - otherwise `pi-clm-server` found on `PATH` (e.g. Homebrew install),
 *   resolved to its absolute path when possible.
 */
export function getNativeServerBinPath(): string | null {
  if (process.env.PI_CLM_SERVER_BIN !== undefined) {
    const override = process.env.PI_CLM_SERVER_BIN;
    if (override === "") return null;
    try {
      fs.accessSync(override, fs.constants.X_OK);
      return override;
    } catch {
      return null;
    }
  }
  const candidate = path.join(getPackageRoot(), "bin", "clm-server");
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    // Fall back to a binary installed on PATH (e.g. Homebrew).
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const onPath = path.join(dir, "pi-clm-server");
      try {
        fs.accessSync(onPath, fs.constants.X_OK);
        return onPath;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

/**
 * The command used to launch the CLM server: the native binary when
 * available (zero dependencies, fast cold start), otherwise
 * `uv run server.py`.
 */
export function buildServerCommand(options: {
  port: number;
  modelPath: string;
  truncation: string;
  serverScriptPath: string;
}): { command: string; args: string[]; native: boolean } {
  const nativeBin = getNativeServerBinPath();
  const flagArgs = [
    "--port",
    options.port.toString(),
    "--model-path",
    options.modelPath,
    "--truncation",
    options.truncation,
  ];
  if (nativeBin) {
    return { command: nativeBin, args: flagArgs, native: true };
  }
  return { command: "uv", args: ["run", options.serverScriptPath, ...flagArgs], native: false };
}

export class ServerManager {
  private options: ResolvedServerManagerOptions;
  private process: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private sessionId: string;
  private isOwner = false;
  private startPromise: Promise<{ pid: number; port: number; host: string }> | null = null;

  constructor(options: ServerManagerOptions = {}) {
    const stateDir = options.stateDir ?? getDefaultStateDir();
    this.options = {
      port: options.port ?? (process.env.PI_CLM_PORT ? parseInt(process.env.PI_CLM_PORT, 10) : DEFAULT_PORT),
      host: options.host ?? process.env.PI_CLM_HOST ?? DEFAULT_HOST,
      modelPath: options.modelPath,
      modelRepo: options.modelRepo,
      hubCacheDir: options.hubCacheDir,
      stateDir,
      serverScriptPath: options.serverScriptPath ?? getDefaultServerScriptPath(),
      startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
      healthIntervalMs: options.healthIntervalMs ?? 500,
      truncation: options.truncation ?? "head",
      logPath: options.logPath ?? path.join(stateDir, LOG_FILENAME),
    };
    this.sessionId = `session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  getLockFilePath(): string {
    return path.join(this.options.stateDir, LOCK_FILENAME);
  }

  getLogFilePath(): string {
    return this.options.logPath;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getOptions(): Readonly<ResolvedServerManagerOptions> {
    return this.options;
  }

  getStateDir(): string {
    return this.options.stateDir;
  }

  getModelRepo(): string {
    return this.options.modelRepo ?? DEFAULT_REPO;
  }

  /** Resolved HF hub cache root used for model storage. */
  getHubCacheDir(): string {
    return getHubCacheDir({ cacheDir: this.options.hubCacheDir });
  }

  /**
   * Model path served by this manager: the HF hub snapshot directory
   * (`models--<org>--<repo>/snapshots/<sha>`), resolved lazily on each call
   * so it reflects a download that happened after construction.
   */
  getModelPath(): string {
    return (
      this.options.modelPath ??
      resolveHubModelPath({ repo: this.getModelRepo(), cacheDir: this.options.hubCacheDir })
    );
  }

  /** Model manager options consistent with this server's model configuration. */
  getModelOptions(): ModelManagerOptions {
    return {
      repo: this.getModelRepo(),
      cacheDir: this.getHubCacheDir(),
    };
  }

  async checkHealth(port?: number, host?: string): Promise<ServerHealthStatus> {
    const targetPort = port ?? this.options.port;
    const targetHost = host ?? this.options.host;
    return new Promise((resolve) => {
      const req = http.get(
        {
          host: targetHost,
          port: targetPort,
          path: "/health",
          timeout: 2000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              if (res.statusCode === 200) {
                const json = JSON.parse(data);
                resolve({ ok: true, status: json.status, model: json.model });
              } else {
                resolve({ ok: false, error: `HTTP ${res.statusCode}` });
              }
            } catch (err: any) {
              resolve({ ok: false, error: err.message });
            }
          });
        }
      );

      req.on("error", (err: any) => {
        resolve({ ok: false, error: err.message });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "Health check timed out" });
      });
    });
  }

  async readLockFile(): Promise<ServerLockInfo | null> {
    try {
      const content = await fsp.readFile(this.getLockFilePath(), "utf-8");
      const info = JSON.parse(content) as ServerLockInfo;
      return info;
    } catch {
      return null;
    }
  }

  async writeLockFile(info: ServerLockInfo): Promise<void> {
    await fsp.mkdir(this.options.stateDir, { recursive: true });
    await fsp.writeFile(this.getLockFilePath(), JSON.stringify(info, null, 2), "utf-8");
  }

  private async recordLockFileForPid(pid: number): Promise<void> {
    const lockInfo: ServerLockInfo = {
      pid,
      port: this.options.port,
      host: this.options.host,
      modelPath: this.getModelPath(),
      startedAt: new Date().toISOString(),
      refCount: 1,
      sessions: [this.sessionId],
    };
    await this.writeLockFile(lockInfo);
  }

  async removeLockFile(): Promise<void> {
    try {
      await fsp.unlink(this.getLockFilePath());
    } catch {
      // Ignore if absent
    }
  }

  async isRunning(): Promise<boolean> {
    const lock = await this.readLockFile();
    if (!lock) {
      const health = await this.checkHealth();
      return health.ok;
    }

    if (!isProcessRunning(lock.pid)) {
      await this.removeLockFile();
      return false;
    }

    const health = await this.checkHealth(lock.port, lock.host);
    if (!health.ok) {
      return false;
    }

    return true;
  }

  async start(): Promise<{ pid: number; port: number; host: string }> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.doStart();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<{ pid: number; port: number; host: string }> {
    // Check if already running
    const lock = await this.readLockFile();
    if (lock) {
      if (isProcessRunning(lock.pid)) {
        const health = await this.checkHealth(lock.port, lock.host);
        if (health.ok) {
          if (!lock.sessions.includes(this.sessionId)) {
            lock.sessions.push(this.sessionId);
            lock.refCount = lock.sessions.length;
            await this.writeLockFile(lock);
          }
          return { pid: lock.pid, port: lock.port, host: lock.host };
        }
      }
      // Dead process or unhealthy
      await this.removeLockFile();
    }

    // Direct health check in case server was started externally
    const directHealth = await this.checkHealth();
    if (directHealth.ok) {
      await this.recordLockFileForPid(0);
      return { pid: 0, port: this.options.port, host: this.options.host };
    }

    // Must spawn server; resolve the model snapshot path (download already
    // happened if the extension drove us here)
    const modelPath = this.getModelPath();

    await fsp.mkdir(this.options.stateDir, { recursive: true });
    const logFilePath = this.options.logPath;
    this.logStream = fs.createWriteStream(logFilePath, { flags: "a" });

    const serverArgs = [
      "--port",
      this.options.port.toString(),
      "--model-path",
      modelPath,
      "--truncation",
      this.options.truncation,
    ];
    const nativeBin = getNativeServerBinPath();
    const command = nativeBin ?? "uv";
    const args = nativeBin ? serverArgs : ["run", this.options.serverScriptPath, ...serverArgs];

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.process = child;
    this.isOwner = true;

    if (child.stdout) {
      child.stdout.pipe(this.logStream, { end: false });
    }
    if (child.stderr) {
      child.stderr.pipe(this.logStream, { end: false });
    }

    let spawnError: Error | null = null;
    child.on("error", (err: Error) => {
      spawnError = err;
    });

    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to spawn Python server: no PID returned");
    }

    await this.recordLockFileForPid(pid);

    // Wait for health check ready
    const startTime = Date.now();
    while (Date.now() - startTime < this.options.startupTimeoutMs) {
      const currentSpawnError = spawnError as Error | null;
      if (currentSpawnError) {
        await this.cleanupFailedSpawn(pid);
        throw new Error(`Failed to launch CLM server: ${currentSpawnError.message}`);
      }
      if (child.exitCode !== null) {
        await this.cleanupFailedSpawn(pid);
        throw new Error(`CLM server exited prematurely with exit code ${child.exitCode}. Check ${logFilePath}`);
      }

      const health = await this.checkHealth();
      if (health.ok) {
        return { pid, port: this.options.port, host: this.options.host };
      }

      await new Promise((r) => setTimeout(r, this.options.healthIntervalMs));
    }

    await this.cleanupFailedSpawn(pid);
    throw new Error(
      `CLM server startup timed out after ${this.options.startupTimeoutMs}ms. ` +
      `Check the log file at ${logFilePath}. ` +
      `To diagnose issues manually, try running: ${command} ${args.join(" ")}`
    );
  }

  private async cleanupFailedSpawn(pid: number): Promise<void> {
    try {
      if (this.process && this.process.exitCode === null) {
        this.process.kill("SIGTERM");
      } else if (pid > 0 && isProcessRunning(pid)) {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Ignore
    }
    await this.removeLockFile();
  }

  async stop(): Promise<void> {
    const lock = await this.readLockFile();
    if (!lock) {
      if (this.process && this.process.exitCode === null) {
        this.process.kill("SIGTERM");
      }
      return;
    }

    // Remove this session from lockfile
    lock.sessions = lock.sessions.filter((s) => s !== this.sessionId);
    lock.refCount = lock.sessions.length;

    if (lock.refCount > 0) {
      // Other sessions are still using it
      await this.writeLockFile(lock);
      return;
    }

    // Last session: perform graceful shutdown
    const targetPid = lock.pid;
    if (targetPid > 0 && isProcessRunning(targetPid)) {
      try {
        process.kill(targetPid, "SIGTERM");
        // Wait up to 5s for graceful exit
        const stopWait = Date.now();
        while (Date.now() - stopWait < 5000) {
          if (!isProcessRunning(targetPid)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (isProcessRunning(targetPid)) {
          process.kill(targetPid, "SIGKILL");
        }
      } catch {
        // Process might have exited
      }
    }

    await this.removeLockFile();

    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
    this.process = null;
    this.isOwner = false;
  }
}
