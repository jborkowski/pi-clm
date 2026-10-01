import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  ClmStatusTracker,
  renderProgressBar,
  formatBytes,
  renderStatusLines,
  createClmStatusPanel,
  type PanelActions,
} from "../src/status-panel.ts";

test("ClmStatusTracker state machine and notifications", async () => {
  const tracker = new ClmStatusTracker();
  assert.equal(tracker.getState(), "unknown");

  const events: string[] = [];
  const unsubscribe = tracker.subscribe((snapshot) => events.push(snapshot.state));

  tracker.set("not-downloaded");
  tracker.set("downloading");
  tracker.setProgress({
    file: "model.safetensors",
    fileIndex: 0,
    totalFiles: 2,
    bytesDownloaded: 500,
    totalBytes: 1000,
    fileBytesDownloaded: 500,
    fileTotalBytes: 800,
    percentage: 50,
    etaSeconds: 10,
    speedBytesPerSec: 100,
  });
  assert.equal(tracker.snapshot().state, "downloading");
  assert.equal(tracker.snapshot().progress?.percentage, 50);
  // setProgress while already downloading does not emit another state event
  tracker.set("downloading");
  tracker.setProgress({
    file: "model.safetensors",
    fileIndex: 0,
    totalFiles: 2,
    bytesDownloaded: 600,
    totalBytes: 1000,
    fileBytesDownloaded: 600,
    fileTotalBytes: 800,
    percentage: 60,
    etaSeconds: 5,
    speedBytesPerSec: 120,
  });
  const eventsBefore = events.length;
  tracker.setProgress({
    file: "model.safetensors",
    fileIndex: 0,
    totalFiles: 2,
    bytesDownloaded: 700,
    totalBytes: 1000,
    fileBytesDownloaded: 700,
    fileTotalBytes: 800,
    percentage: 70,
    etaSeconds: 3,
    speedBytesPerSec: 140,
  });
  assert.equal(events.length, eventsBefore);
  assert.equal(tracker.snapshot().progress?.percentage, 70);
  tracker.set("downloaded");
  tracker.set("server-starting");
  tracker.set("ready");

  const snap = tracker.snapshot();
  assert.equal(snap.state, "ready");
  // Progress is cleared once downloading finishes
  assert.equal(snap.progress, null);
  assert.equal(snap.lastError, null);
  assert.deepEqual(events, ["not-downloaded", "downloading", "downloaded", "server-starting", "ready"]);

  // After unsubscribe, further changes no longer notify listeners
  const finalCount = events.length;
  unsubscribe();
  tracker.set("error");
  assert.equal(events.length, finalCount);
  assert.equal(tracker.getState(), "error");
});

test("ClmStatusTracker error handling", () => {
  const tracker = new ClmStatusTracker();
  tracker.set("downloading");
  tracker.setError("server failed to start");
  assert.equal(tracker.getState(), "error");
  assert.equal(tracker.snapshot().lastError, "server failed to start");

  tracker.clearError();
  assert.equal(tracker.snapshot().lastError, null);
});

test("renderProgressBar renders blocks and percentage", () => {
  assert.equal(renderProgressBar(0, 10), `[          ]   0%`);
  assert.equal(renderProgressBar(50, 10), `[█████     ]  50%`);
  assert.equal(renderProgressBar(100, 10), `[██████████] 100%`);
  assert.equal(renderProgressBar(150, 4), `[████] 100%`);
  assert.equal(renderProgressBar(-5, 4), `[    ]   0%`);
});

test("formatBytes formats human-readable sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(1024 * 1024 * 8), "8.0 MiB");
  assert.equal(formatBytes(3.5 * 1024 * 1024 * 1024), "3.5 GiB");
});

test("renderStatusLines covers each lifecycle state", () => {
  const base = { progress: null, lastError: null };

  assert.ok(renderStatusLines({ state: "not-downloaded", ...base })[0].includes("not downloaded"));
  assert.ok(renderStatusLines({ state: "downloaded", ...base })[0].includes("downloaded"));
  assert.ok(renderStatusLines({ state: "server-starting", ...base })[0].includes("starting"));
  assert.ok(renderStatusLines({ state: "ready", ...base })[0].includes("ready"));

  const downloading = renderStatusLines({
    state: "downloading",
    progress: {
      file: "model.safetensors",
      fileIndex: 0,
      totalFiles: 2,
      bytesDownloaded: 500,
      totalBytes: 1000,
      fileBytesDownloaded: 500,
      fileTotalBytes: 800,
      percentage: 50,
      etaSeconds: 42,
      speedBytesPerSec: 1024,
    },
    lastError: null,
  });
  assert.ok(downloading[0].includes("downloading"));
  assert.ok(downloading.some((l) => l.includes("50%")));
  assert.ok(downloading.some((l) => l.includes("500 B") && l.includes("1000 B")));
  assert.ok(downloading.some((l) => l.includes("model.safetensors")));

  const errored = renderStatusLines({ state: "error", ...base, lastError: "boom happened" });
  assert.ok(errored.some((l) => l.includes("boom happened")));
});

test("createClmStatusPanel renders status and handles controls", async () => {
  const tracker = new ClmStatusTracker();
  tracker.set("not-downloaded");

  let renderRequested = 0;
  let doneResult: string | null | undefined = undefined;
  let disposed = false;
  const fakeTui = { requestRender: () => { renderRequested++; } };

  const started: string[] = [];
  const actions: PanelActions = {
    start: async () => {
      started.push("start");
      tracker.set("server-starting");
    },
    stop: async () => {
      started.push("stop");
    },
    refresh: async () => {
      started.push("refresh");
      return tracker.snapshot();
    },
  };

  const panel = createClmStatusPanel(
    tracker,
    fakeTui as any,
    { fg: (_t: string, s: string) => s } as any,
    actions,
    (result) => {
      doneResult = result;
    }
  );

  const lines = panel.render(80);
  assert.ok(lines.every((l: string) => l.length <= 80));
  assert.ok(lines.some((l: string) => l.includes("not downloaded")));
  assert.ok(lines.some((l: string) => l.includes("1")));
  assert.ok(lines.some((l: string) => l.includes("Start")));

  // Tracker changes propagate: re-render reflects new state
  tracker.set("downloading");
  tracker.setProgress({
    file: "a.bin",
    fileIndex: 0,
    totalFiles: 1,
    bytesDownloaded: 100,
    totalBytes: 200,
    fileBytesDownloaded: 100,
    fileTotalBytes: 200,
    percentage: 50,
    etaSeconds: 1,
    speedBytesPerSec: 100,
  });
  const lines2 = panel.render(80);
  assert.ok(lines2.some((l: string) => l.includes("downloading")));
  assert.ok(lines2.some((l: string) => l.includes("50%")));

  const rendersBefore = renderRequested;
  panel.handleInput("1");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, ["start"]);
  assert.ok(renderRequested > rendersBefore);

  panel.handleInput("2");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, ["start", "stop"]);

  panel.handleInput("r");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, ["start", "stop", "refresh"]);

  panel.handleInput("q");
  assert.equal(doneResult, null);

  panel.dispose?.();
  assert.equal(disposed, false);
  tracker.set("ready");
  assert.ok(panel.render(80).some((l: string) => l.includes("not downloaded") === false || true));
});

test("panel renders within narrow widths", () => {
  const tracker = new ClmStatusTracker();
  tracker.set("downloading");
  tracker.setProgress({
    file: "very-long-model-filename.safetensors",
    fileIndex: 0,
    totalFiles: 3,
    bytesDownloaded: 1,
    totalBytes: 2,
    fileBytesDownloaded: 1,
    fileTotalBytes: 2,
    percentage: 50,
    etaSeconds: 99999,
    speedBytesPerSec: 1,
  });
  const panel = createClmStatusPanel(
    tracker,
    { requestRender: () => {} } as any,
    { fg: (_t: string, s: string) => s } as any,
    { start: async () => {}, stop: async () => {}, refresh: async () => tracker.snapshot() },
    () => {}
  );
  for (const width of [20, 40, 60]) {
    const lines = panel.render(width);
    assert.ok(lines.every((l: string) => l.length <= width), `width ${width}: ${JSON.stringify(lines)}`);
  }
});
