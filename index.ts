import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ClassifierModel, ClassifierContext, ClassifierOptions, ClassifierResult } from "@earendil-works/pi-ai";
import {
  MODELS,
  findModel,
  findVariant,
  formatVariantLine,
  loadConfig,
  saveConfig,
  resolveRepo,
  type ClmConfig,
} from "./src/model-config.ts";
import { ServerManager, DEFAULT_PORT } from "./src/server-manager.ts";
import { status, download, type ModelManagerOptions } from "./src/model-manager.ts";
import {
  ClmStatusTracker,
  createClmStatusPanel,
  renderStatusLines,
  type PanelActions,
} from "./src/status-panel.ts";
export * from "./src/model-manager.ts";
export * from "./src/model-config.ts";
export * from "./src/server-manager.ts";
export * from "./src/status-panel.ts";

export interface ExtensionOptions {
  serverManager?: ServerManager;
  modelOptions?: ModelManagerOptions;
  statusTracker?: ClmStatusTracker;
}

export default async function (pi: ExtensionAPI, extensionOptions?: ExtensionOptions) {
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

  // Apply a persisted model/quantization choice on startup. When the menu
  // was never opened there is no config file and defaults stay untouched.
  const configStateDir = serverManager.getStateDir();
  const savedConfig = await loadConfig(configStateDir);
  if (savedConfig) {
    serverManager.setModelRepo(resolveRepo(savedConfig));
  }


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

  // First use: no model/quantization choice saved yet — point the user at
  // the menu without interrupting anything.
  pi.on("session_start", async (_event, ctx) => {
    if (savedConfig) return;
    ctx.ui.notify(
      "CLM: no model variant chosen yet — run /clm configure to pick a model and quantization level (4-bit recommended for memory-constrained Macs). Using the default meanwhile.",
      "info"
    );
  });

  /** Minimal UI surface needed by the configure menu. */
  interface ConfigureUI {
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, level: "info" | "error"): Promise<void> | void;
  }

  /**
   * Friendly model/quantization selection menu. Persists the choice in the
   * extension config and applies it to future downloads and server starts.
   */
  const runConfigureMenu = async (ui: ConfigureUI, current: ClmConfig | null): Promise<void> => {
    const model = findModel(current?.modelId ?? MODELS[0].id) ?? MODELS[0];
    const modelChoice = await ui.select(
      "CLM: choose a model",
      MODELS.map((m) => m.label)
    );
    if (modelChoice === undefined) {
      await ui.notify("CLM: configuration cancelled", "info");
      return;
    }
    const chosenModel = MODELS.find((m) => m.label === modelChoice) ?? model;

    const variantChoice = await ui.select(
      `CLM: choose a quantization level for ${chosenModel.label}`,
      chosenModel.variants.map((v) => formatVariantLine(chosenModel, v))
    );
    if (variantChoice === undefined) {
      await ui.notify("CLM: configuration cancelled", "info");
      return;
    }
    const chosenVariant =
      chosenModel.variants.find((v) => formatVariantLine(chosenModel, v) === variantChoice) ??
      chosenModel.variants[0];

    const config: ClmConfig = { modelId: chosenModel.id, quantizationId: chosenVariant.id };
    await saveConfig(config, configStateDir);
    serverManager.setModelRepo(resolveRepo(config));

    // A running server keeps the old model; restart so the choice applies now.
    const wasRunning = await serverManager.isRunning();
    if (wasRunning) {
      statusTracker.set("stopping");
      await serverManager.stop();
      statusTracker.set("downloaded");
    }
    await ui.notify(
      `CLM: set to ${chosenModel.label} ${chosenVariant.label} (${chosenVariant.repo})` +
        (wasRunning ? " — server stopped; it will start with the new variant on next use" : ""),
      "info"
    );
  };

  // /clm — status panel and server controls
  pi.registerCommand("clm", {
    description: "Show CLM model/server status and start/stop controls",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "configure") {
        await runConfigureMenu(ctx.ui, savedConfig);
        return;
      }
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
