import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ClassifierModel, ClassifierContext, ClassifierOptions, ClassifierResult } from "@earendil-works/pi-ai";
import { ServerManager, DEFAULT_PORT } from "./src/server-manager.ts";
import { status, download, type ModelManagerOptions } from "./src/model-manager.ts";
import {
  ClmStatusTracker,
  createClmStatusPanel,
  renderStatusLines,
  type PanelActions,
} from "./src/status-panel.ts";
export * from "./src/model-manager.ts";
export * from "./src/server-manager.ts";
export * from "./src/status-panel.ts";

export interface ExtensionOptions {
  serverManager?: ServerManager;
  modelOptions?: ModelManagerOptions;
  statusTracker?: ClmStatusTracker;
}

export default function (pi: ExtensionAPI, extensionOptions?: ExtensionOptions) {
  // Pi aliases this public entrypoint for extensions outside node_modules.
  // Arbitrary pi-ai subpath imports are not resolved by that loader.
  const typesafe = builtinProviders().find((provider) => provider.id === "typesafe");
  if (!typesafe?.classify) throw new Error("This Pi version lacks the TypeSafe classifier");
  const baseClassify = typesafe.classify.bind(typesafe);

  const serverManager =
    extensionOptions?.serverManager ??
    new ServerManager({
      modelRepo: extensionOptions?.modelOptions?.repo,
      hubCacheDir: extensionOptions?.modelOptions?.cacheDir,
    });

  const statusTracker = extensionOptions?.statusTracker ?? new ClmStatusTracker();

  const modelManagerOptions = (): ModelManagerOptions => ({
    ...serverManager.getModelOptions(),
    ...extensionOptions?.modelOptions,
  });

  /** Recompute tracker state from disk + health checks. */
  const refreshStatus = async (): Promise<void> => {
    if (await serverManager.isRunning()) {
      statusTracker.set("ready");
      return;
    }
    const modelStatus = await status(modelManagerOptions());
    statusTracker.set(modelStatus.valid ? "downloaded" : "not-downloaded");
  };

  // Single-flight: concurrent classify calls share one ensure/download/start attempt
  let ensureReadyPromise: Promise<void> | null = null;
  const ensureReady = async (): Promise<void> => {
    if (ensureReadyPromise) return ensureReadyPromise;
    ensureReadyPromise = (async () => {
      try {
        const isRunning = await serverManager.isRunning();
        if (!isRunning) {
          // Ensure model is downloaded and verified before starting server
          const mmOptions = modelManagerOptions();
          const modelStatus = await status(mmOptions);
          if (!modelStatus.valid) {
            statusTracker.set("downloading");
            await download(mmOptions, (progress) => statusTracker.setProgress(progress));
          }
          statusTracker.set("downloaded");
          statusTracker.set("server-starting");
        }
        // start() also attaches this session to an already-running server (refCount++)
        await serverManager.start();
        statusTracker.set("ready");
        statusTracker.clearError();
      } catch (err: any) {
        statusTracker.setError(err?.message ?? String(err));
        throw err;
      }
    })();
    try {
      return await ensureReadyPromise;
    } finally {
      ensureReadyPromise = null;
    }
  };

  const classifyWrapper = async (
    model: ClassifierModel<any>,
    context: ClassifierContext,
    options?: ClassifierOptions
  ): Promise<ClassifierResult> => {
    // Ensure server is running and session is registered in lockfile
    await ensureReady();
    return baseClassify(model, context, options);
  };

  pi.on("session_shutdown", async () => {
    const state = statusTracker.getState();
    if (state === "ready" || state === "server-starting") {
      statusTracker.set("stopping");
    }
    await serverManager.stop();
    if (statusTracker.getState() === "stopping") {
      statusTracker.set("downloaded");
    }
  });

  // /clm — status panel and server controls
  pi.registerCommand("clm", {
    description: "Show CLM model/server status and start/stop controls",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "start" || sub === "stop" || sub === "status") {
        try {
          if (sub === "start") {
            await ensureReady();
            await ctx.ui.notify("CLM: ready", "info");
          } else if (sub === "stop") {
            statusTracker.set("stopping");
            await serverManager.stop();
            statusTracker.set("downloaded");
            await ctx.ui.notify("CLM: server stopped", "info");
          } else {
            await refreshStatus();
            for (const line of renderStatusLines(statusTracker.snapshot())) {
              await ctx.ui.notify(line, "info");
            }
          }
        } catch (err: any) {
          const message = err?.message ?? String(err);
          statusTracker.setError(message);
          await ctx.ui.notify(`CLM: ${message}`, "error");
        }
        return;
      }

      const actions: PanelActions = {
        start: () => ensureReady(),
        stop: async () => {
          statusTracker.set("stopping");
          await serverManager.stop();
          statusTracker.set("downloaded");
        },
        refresh: async () => {
          await refreshStatus();
          return statusTracker.snapshot();
        },
      };

      // Non-TUI modes: no panel, report status via notifications
      if (ctx.mode !== "tui") {
        await refreshStatus();
        for (const line of renderStatusLines(statusTracker.snapshot())) {
          ctx.ui.notify(line, "info");
        }
        return;
      }

      await refreshStatus();
      await ctx.ui.custom<null>((tui, theme, _keybindings, done) =>
        createClmStatusPanel(statusTracker, tui, theme, actions, done)
      );
    },
  });

  pi.registerProvider("clm-local", {
    apiKey: "local", // Pi requires a key; the loopback server does not authenticate.
    models: [{
      type: "classifier",
      id: "clm-latest",
      name: "CLM MLX (local)",
      api: "typesafe-system-one",
      baseUrl: `http://${serverManager.getOptions().host}:${serverManager.getOptions().port}/v1`,
      input: ["text"],
      contextWindow: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    classifiers: { "typesafe-system-one": { classify: classifyWrapper } },
  });
}
