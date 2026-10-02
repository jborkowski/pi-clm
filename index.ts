import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Type } from "@earendil-works/pi-ai";
import type { ClassifierModel, ClassifierContext, ClassifierOptions, ClassifierResult, JsonObject } from "@earendil-works/pi-ai";
import {
  MODELS,
  formatVariantLine,
  loadConfig,
  saveConfig,
  resolveRepo,
  type ClmConfig,
} from "./src/model-config.ts";
import { ServerManager, DEFAULT_PORT, getNativeServerBinPath, nativeServerCanServe } from "./src/server-manager.ts";
import { status, download, type ModelManagerOptions } from "./src/model-manager.ts";
import {
  ClmStatusTracker,
  createClmStatusPanel,
  renderStatusLines,
  type PanelActions,
} from "./src/status-panel.ts";
import { createClm, DEFAULT_SCORE_CRITERIA, type ClmAnswer, type ClmBoolAnswer, type ClmScoreAnswer } from "./src/codemode.ts";
export * from "./src/model-manager.ts";
export * from "./src/model-config.ts";
export * from "./src/server-manager.ts";
export * from "./src/status-panel.ts";
export * from "./src/codemode.ts";

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
  let savedConfig = await loadConfig(configStateDir);
  if (savedConfig) {
    serverManager.setModelRepo(resolveRepo(savedConfig));
  }

  // The saved /clm configure choice is the single source of truth: when a
  // programmatic modelOptions.repo was registered and a different choice is
  // already saved, say so once instead of silently diverging.
  const pinnedRepo = extensionOptions?.modelOptions?.repo;
  let repoOverrideNotice: string | null = null;
  if (pinnedRepo && savedConfig) {
    const effectiveRepo = resolveRepo(savedConfig);
    if (effectiveRepo !== pinnedRepo) {
      repoOverrideNotice =
        `CLM: using the saved /clm configure choice (${effectiveRepo}); it overrides the registered modelOptions.repo (${pinnedRepo})`;
    }
  }

  const modelManagerOptions = (): ModelManagerOptions => ({
    ...serverManager.getModelOptions(),
    ...extensionOptions?.modelOptions,
    repo: serverManager.getModelRepo(),
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
    if (repoOverrideNotice) {
      ctx.ui.notify(repoOverrideNotice, "info");
      repoOverrideNotice = null;
    }
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
  const runConfigureMenu = async (ui: ConfigureUI): Promise<void> => {
    const modelChoice = await ui.select(
      "CLM: choose a model",
      MODELS.map((m) => m.label)
    );
    if (modelChoice === undefined) {
      await ui.notify("CLM: configuration cancelled", "info");
      return;
    }
    const chosenModel = MODELS.find((m) => m.label === modelChoice)!;

    const variantChoice = await ui.select(
      `CLM: choose a quantization level for ${chosenModel.label}`,
      chosenModel.variants.map((v) => formatVariantLine(chosenModel, v))
    );
    if (variantChoice === undefined) {
      await ui.notify("CLM: configuration cancelled", "info");
      return;
    }
    const chosenVariant = chosenModel.variants.find(
      (v) => formatVariantLine(chosenModel, v) === variantChoice
    )!;

    const config: ClmConfig = { modelId: chosenModel.id, quantizationId: chosenVariant.id };
    await saveConfig(config, configStateDir);
    savedConfig = config;
    const repo = resolveRepo(config);
    serverManager.setModelRepo(repo);

    const usesPythonFallback = getNativeServerBinPath() !== null && !(await nativeServerCanServe(repo));
    if (usesPythonFallback) {
      await ui.notify(
        "CLM: the available native server does not support this variant's quantization — the Python fallback will be used for it (requires uv)",
        "info"
      );
    }

    // A running server keeps the old model. Stopping it hands the next start
    // the new variant, but only this session's own single-owner server is
    // stopped; a server shared with other sessions or started externally
    // keeps serving the previous variant until it stops.
    let serverNote = "";
    if (await serverManager.isRunning()) {
      statusTracker.set("stopping");
      await serverManager.stop();
      if (await serverManager.isRunning()) {
        statusTracker.set("ready");
        serverNote =
          " — the running server is shared with other sessions or was started externally; it keeps serving the previous variant until it stops";
      } else {
        statusTracker.set("downloaded");
        serverNote = usesPythonFallback
          ? " — server stopped; it will start with the new variant on next use via the Python fallback"
          : " — server stopped; it will start with the new variant on next use";
      }
    }
    await ui.notify(
      `CLM: set to ${chosenModel.label} ${chosenVariant.label} (${chosenVariant.repo})${serverNote}`,
      "info"
    );
  };

  // /clm — status panel and server controls
  pi.registerCommand("clm", {
    description: "Show CLM model/server status and start/stop controls",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "configure" || sub === "start" || sub === "stop" || sub === "status") {
        try {
          if (sub === "configure") {
            await runConfigureMenu(ctx.ui);
          } else if (sub === "start") {
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

  const clmModel: ClassifierModel<"typesafe-system-one"> = {
    type: "classifier",
    id: "clm-latest",
    name: "CLM MLX (local)",
    api: "typesafe-system-one",
    provider: "clm-local",
    baseUrl: `http://${serverManager.getOptions().host}:${serverManager.getOptions().port}/v1`,
    input: ["text"],
    contextWindow: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  // Pi requires an API key even though the loopback server does not authenticate.
  const CLM_LOCAL_API_KEY = "local";

  const clm = createClm((context) => classifyWrapper(clmModel, context, { apiKey: CLM_LOCAL_API_KEY }));

  // Code-mode surface (issue #9): codemode-only tools returning structured
  // JSON via outputSchema/structuredContent, so sandbox scripts call
  // `tools.clm_bool(...)` etc. and compose with Promise.all — no rendered-text
  // parsing, no string dispatch.
  const clmNamespace = {
    name: "clm",
    description: "Local CLM classifier: typed yes/no, choice, and score questions with probabilities",
    instructions:
      "Each tool returns a structured ClmAnswer: { answer, probabilities, confidence, question } " +
      "(score adds `value`). `state` defaults to { message: question }; pass it to classify a " +
      "specific text instead of the question itself.",
  };
  const clmStructured = (answer: JsonObject) => ({
    content: [{ type: "text" as const, text: JSON.stringify(answer) }],
    structuredContent: answer,
    details: undefined,
  });

  pi.registerTool({
    name: "clm_bool",
    label: "CLM yes/no",
    description: "Ask the local CLM classifier a yes/no question; returns a ClmAnswer over \"yes\" | \"no\".",
    exposure: "codemode",
    namespace: clmNamespace,
    parameters: Type.Object({
      question: Type.String({ description: "The yes/no question to ask" }),
      state: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "State to classify; defaults to { message: question }" })),
    }),
    outputSchema: Type.Object({
      answer: Type.Union([Type.Literal("yes"), Type.Literal("no")]),
      probabilities: Type.Object({
        yes: Type.Number(),
        no: Type.Number(),
      }),
      confidence: Type.Number(),
      question: Type.String(),
    }),
    async execute(_id, params) {
      return clmStructured((await clm.bool(params.question, params.state as JsonObject | undefined)) as unknown as JsonObject);
    },
  });

  pi.registerTool({
    name: "clm_choice",
    label: "CLM choice",
    description: "Ask the local CLM classifier a single-choice question; returns a ClmAnswer typed over the criteria keys.",
    exposure: "codemode",
    namespace: clmNamespace,
    parameters: Type.Object({
      question: Type.String({ description: "The choice question to ask" }),
      criteria: Type.Record(Type.String(), Type.String(), { description: "Map of criterion key to its description" }),
      state: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "State to classify; defaults to { message: question }" })),
    }),
    outputSchema: Type.Object({
      answer: Type.String(),
      probabilities: Type.Record(Type.String(), Type.Number()),
      confidence: Type.Number(),
      question: Type.String(),
    }),
    async execute(_id, params) {
      return clmStructured((await clm.choice(params.question, params.criteria as Record<string, string>, params.state as JsonObject | undefined)) as unknown as JsonObject);
    },
  });

  pi.registerTool({
    name: "clm_score",
    label: "CLM score",
    description: `Ask the local CLM classifier for a score; returns { answer, value, confidence, question }. Criteria default to ${DEFAULT_SCORE_CRITERIA.join(", ")}.`,
    exposure: "codemode",
    namespace: clmNamespace,
    parameters: Type.Object({
      question: Type.String({ description: "The scoring question to ask" }),
      criteria: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]), { description: "Ordered criteria labels, lowest to highest" })),
      state: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "State to classify; defaults to { message: question }" })),
    }),
    outputSchema: Type.Object({
      answer: Type.String(),
      value: Type.Number(),
      confidence: Type.Number(),
      question: Type.String(),
    }),
    async execute(_id, params) {
      return clmStructured((await clm.score(params.question, params.criteria, params.state as JsonObject | undefined)) as unknown as JsonObject);
    },
  });

  pi.registerProvider("clm-local", {
    apiKey: CLM_LOCAL_API_KEY,
    models: [clmModel],
    classifiers: { "typesafe-system-one": { classify: classifyWrapper } },
  });
}
