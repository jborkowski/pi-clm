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
import { createClm, toWireQuestion, type ClmEvidence, type ClmQuestionSet } from "./src/codemode.ts";
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

  // First use: the extension starts silently with its defaults; the
  // discoverability hint for /clm configure lives in the README.
  pi.on("session_start", async (_event, ctx) => {
    if (repoOverrideNotice) {
      ctx.ui.notify(repoOverrideNotice, "info");
      repoOverrideNotice = null;
    }
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

  // Code-mode surface: one composable tool. A single call judges one state
  // against a fan-out of caller-labeled questions and returns typed answers
  // (with full distributions) keyed by the same ids — no Promise.all, no
  // rendered-text parsing, no string dispatch.
  const boolQuestion = Type.Object({
    kind: Type.Literal("bool"),
    instructions: Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]),
    criteria: Type.Optional(
      Type.Object({
        true: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
        false: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
      }),
    ),
  });
  const choiceQuestion = Type.Object({
    kind: Type.Literal("choice"),
    instructions: Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]),
    criteria: Type.Record(Type.String(), Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  });
  const scoreQuestion = Type.Object({
    kind: Type.Literal("score"),
    instructions: Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]),
    criteria: Type.Array(Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]), {
      minItems: 2,
      maxItems: 10,
      description: "Ordered levels, lowest to highest",
    }),
  });
  const questionSchema = Type.Union([boolQuestion, choiceQuestion, scoreQuestion]);
  const answerSchema = Type.Union([
    Type.Object({
      kind: Type.Literal("bool"),
      probability: Type.Number({ description: "P(true), 0-1" }),
    }),
    Type.Object({
      kind: Type.Literal("choice"),
      choice: Type.String(),
      probabilities: Type.Record(Type.String(), Type.Number()),
      confidence: Type.Number({ description: "(pmax - 1/n) / (1 - 1/n): 0 for uniform, 1 for certain" }),
    }),
    Type.Object({
      kind: Type.Literal("score"),
      score: Type.Number({ description: "Probability-weighted position across levels, 0-1; level i of n sits at i/(n-1)" }),
      legend: Type.Record(Type.String(), Type.String(), { description: "Level position to level text" }),
      probabilities: Type.Record(Type.String(), Type.Number()),
      confidence: Type.Number({ description: "Distance-aware: adjacent splits count less than extreme splits" }),
    }),
  ]);

  pi.registerTool({
    name: "clm",
    label: "CLM",
    description:
      "Judge one state against a fan-out of independent questions. One call, one state, many labeled questions; every answer carries its full probability distribution. Kinds: bool (P(true)), choice (chosen key + distribution + derived confidence), score (probability-weighted position across 2-10 ordered levels + legend + distance-aware confidence).",
    exposure: "codemode",
    namespace: {
      name: "clm",
      description: "Local CLM classifier judgment primitives: state separated from questions, discriminated question kinds, distributions as first-class data",
      instructions:
        "Pass the evidence once as `state` and any number of questions keyed by stable ids; all questions see the same state and are judged independently. " +
        "Answers come back keyed by the same ids. Thresholds are application policy — the tool reports distributions.",
    },
    parameters: Type.Object({
      state: Type.Unknown({ description: "The evidence being judged: a string, object, or array" }),
      questions: Type.Record(Type.String(), questionSchema, {
        description: "Questions keyed by caller-chosen stable ids",
      }),
    }),
    outputSchema: Type.Object({
      answers: Type.Record(Type.String(), answerSchema, { description: "Answers keyed by the question ids" }),
    }),
    async execute(_id, params) {
      const questions = params.questions as ClmQuestionSet;
      // Validate translation up front so bad question shapes reject cleanly.
      for (const [id, question] of Object.entries(questions)) {
        try {
          toWireQuestion(question);
        } catch (err: any) {
          throw new Error(`question "${id}": ${err?.message ?? String(err)}`);
        }
      }
      const answers = await clm.ask(params.state as ClmEvidence, questions);
      const structured = { answers } as unknown as JsonObject;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structured) }],
        structuredContent: structured,
        details: undefined,
      };
    },
  });

  pi.registerProvider("clm-local", {
    apiKey: CLM_LOCAL_API_KEY,
    models: [clmModel],
    classifiers: { "typesafe-system-one": { classify: classifyWrapper } },
  });
}
