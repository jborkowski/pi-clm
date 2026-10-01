import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ClassifierModel, ClassifierContext, ClassifierOptions, ClassifierResult } from "@earendil-works/pi-ai";
import { ServerManager, DEFAULT_PORT } from "./src/server-manager.ts";
export * from "./src/model-manager.ts";
export * from "./src/server-manager.ts";

export default function (pi: ExtensionAPI) {
  // Pi aliases this public entrypoint for extensions outside node_modules.
  // Arbitrary pi-ai subpath imports are not resolved by that loader.
  const typesafe = builtinProviders().find((provider) => provider.id === "typesafe");
  if (!typesafe?.classify) throw new Error("This Pi version lacks the TypeSafe classifier");
  const baseClassify = typesafe.classify.bind(typesafe);

  const serverManager = new ServerManager();

  const classifyWrapper = async (
    model: ClassifierModel<any>,
    context: ClassifierContext,
    options?: ClassifierOptions
  ): Promise<ClassifierResult> => {
    // Auto-start server if not already running
    const isRunning = await serverManager.isRunning();
    if (!isRunning) {
      await serverManager.start();
    }
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
      name: "CLM MLX 8bit (local)",
      api: "typesafe-system-one",
      baseUrl: `http://127.0.0.1:${DEFAULT_PORT}/v1`,
      input: ["text"],
      contextWindow: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    classifiers: { "typesafe-system-one": { classify: classifyWrapper } },
  });
}
