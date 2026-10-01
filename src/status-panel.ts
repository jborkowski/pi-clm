import type { ProgressReport } from "./model-manager.ts";

export type ClmState =
  | "unknown"
  | "not-downloaded"
  | "downloading"
  | "downloaded"
  | "server-starting"
  | "ready"
  | "stopping"
  | "error";

export interface ClmStatusSnapshot {
  state: ClmState;
  progress: ProgressReport | null;
  lastError: string | null;
}

type Listener = (snapshot: ClmStatusSnapshot) => void;

/**
 * Tracks the CLM lifecycle state (model download -> server start -> ready)
 * and notifies subscribers so TUI components can re-render.
 */
export class ClmStatusTracker {
  private state: ClmState = "unknown";
  private progress: ProgressReport | null = null;
  private lastError: string | null = null;
  private listeners = new Set<Listener>();

  getState(): ClmState {
    return this.state;
  }

  snapshot(): ClmStatusSnapshot {
    return { state: this.state, progress: this.progress, lastError: this.lastError };
  }

  set(state: ClmState): void {
    if (this.state === state) return;
    this.state = state;
    if (state !== "downloading") this.progress = null;
    this.emit();
  }

  setProgress(progress: ProgressReport): void {
    this.progress = progress;
    if (this.state !== "downloading") {
      this.state = "downloading";
      this.emit();
    }
  }

  setError(message: string): void {
    this.lastError = message;
    this.state = "error";
    this.emit();
  }

  clearError(): void {
    this.lastError = null;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken listener must not break the state machine
      }
    }
  }
}

export function renderProgressBar(percentage: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * width);
  const pctLabel = `${Math.round(clamped)}`.padStart(3, " ");
  return `[${"█".repeat(filled)}${" ".repeat(width - filled)}] ${pctLabel}%`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}

const STATE_LABELS: Record<ClmState, string> = {
  unknown: "unknown",
  "not-downloaded": "model not downloaded",
  downloading: "downloading model",
  downloaded: "model downloaded",
  "server-starting": "server starting",
  ready: "ready",
  stopping: "stopping server",
  error: "error",
};

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

/** Plain-text status lines for the current snapshot (one line per entry, no ANSI). */
export function renderStatusLines(snapshot: ClmStatusSnapshot): string[] {
  const lines: string[] = [`CLM: ${STATE_LABELS[snapshot.state]}`];

  if (snapshot.state === "downloading" && snapshot.progress) {
    const p = snapshot.progress;
    lines.push(`  ${renderProgressBar(p.percentage)}  ${formatBytes(p.bytesDownloaded)} / ${formatBytes(p.totalBytes)}`);
    let detail = `  file ${p.fileIndex + 1}/${p.totalFiles}: ${p.file}`;
    if (p.etaSeconds !== null) {
      detail += ` — ETA ${Math.max(1, Math.round(p.etaSeconds))}s`;
    }
    if (p.speedBytesPerSec > 0) {
      detail += ` (${formatBytes(p.speedBytesPerSec)}/s)`;
    }
    lines.push(detail);
  }

  if (snapshot.state === "error" && snapshot.lastError) {
    lines.push(`  last error: ${snapshot.lastError}`);
  }

  return lines;
}

export interface PanelActions {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<ClmStatusSnapshot>;
}

/** Minimal theme shape used by the panel; Pi's Theme satisfies this. */
interface ThemeLike {
  fg(token: string, text: string): string;
}

interface PanelComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
  dispose?(): void;
}

/**
 * Self-contained interactive TUI panel for CLM status and controls.
 * Uses `ctx.ui.custom()` component contract (render/invalidate/handleInput/dispose)
 * without importing pi-tui subpaths, so it loads under Pi's extension aliasing.
 *
 * Keys: 1 = start server, 2 = stop server, r = refresh, q/ESC = close.
 */
export function createClmStatusPanel(
  tracker: ClmStatusTracker,
  tui: { requestRender(): void },
  theme: ThemeLike,
  actions: PanelActions,
  done: (result: null) => void
): PanelComponent {
  let busy = false;

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (err: any) {
      tracker.setError(err?.message ?? String(err));
    } finally {
      busy = false;
      tui.requestRender();
    }
  };

  const panel: PanelComponent = {
    render(width: number): string[] {
      const snapshot = tracker.snapshot();
      const borderLen = Math.max(0, width - 2);
      const contentWidth = Math.max(4, width - 4);
      const source = [...renderStatusLines(snapshot), "", "Controls: 1 Start server  2 Stop server  r Refresh  q Close"];
      const border = theme.fg("accent", `┌${"─".repeat(borderLen)}┐`);
      const bottom = theme.fg("accent", `└${"─".repeat(borderLen)}┘`);
      const body = source.map((line) => {
        const content = truncate(line, contentWidth).padEnd(contentWidth);
        return `│ ${content} │`;
      });
      return [border, ...body, bottom];
    },
    invalidate() {
      // Stateless per-render; nothing to cache.
    },
    handleInput(data: string) {
      if (data === "\u001b" || data === "q") {
        done(null);
        return;
      }
      if (data === "1") {
        void run(() => actions.start());
        return;
      }
      if (data === "2") {
        void run(() => actions.stop());
        return;
      }
      if (data === "r") {
        void run(async () => {
          await actions.refresh();
        });
        return;
      }
    },
    dispose() {
      unsubscribe();
    },
  };

  const unsubscribe = tracker.subscribe(() => {
    tui.requestRender();
  });

  return panel;
}
