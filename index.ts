import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ClassifierModel, ClassifierContext, ClassifierOptions, ClassifierResult } from "@earendil-works/pi-ai";
import { ServerManager, DEFAULT_PORT } from "./src/server-manager.ts";
import { status, download, getModelPath, type ModelManagerOptions } from "./src/model-manager.ts";
export * from "./src/model-manager.ts";
export * from "./src/server-manager.ts";

export interface ExtensionOptions {
  serverManager?: ServerManager;
  modelOptions?: ModelManagerOptions;
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
      modelPath: extensionOptions?.modelOptions ? getModelPath(extensionOptions.modelOptions) : undefined,
    });

  // Single-flight: concurrent classify calls share one ensure/download/start attempt
  let ensureReadyPromise: Promise<void> | null = null;
  const ensureReady = async (): Promise<void> => {
    if (ensureReadyPromise) return ensureReadyPromise;
    ensureReadyPromise = (async () => {
      const isRunning = await serverManager.isRunning();
      if (!isRunning) {
        // Ensure model is downloaded and verified before starting server
        const mmOptions: ModelManagerOptions = {
          cacheDir: serverManager.getCacheDir(),
          ...extensionOptions?.modelOptions,
        };
        const modelStatus = await status(mmOptions);
        if (!modelStatus.valid) {
          await download(mmOptions);
        }
      }
      await serverManager.start();
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
    await serverManager.stop();
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
