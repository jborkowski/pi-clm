import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export default function (pi: ExtensionAPI) {
  // Pi aliases this public entrypoint for extensions outside node_modules.
  // Arbitrary pi-ai subpath imports are not resolved by that loader.
  const typesafe = builtinProviders().find((provider) => provider.id === "typesafe");
  if (!typesafe?.classify) throw new Error("This Pi version lacks the TypeSafe classifier");
  const classify = typesafe.classify.bind(typesafe);
  pi.registerProvider("clm-local", {
    apiKey: "local", // Pi requires a key; the loopback server does not authenticate.
    models: [{
      type: "classifier",
      id: "clm-latest",
      name: "CLM MLX 8bit (local)",
      api: "typesafe-system-one",
      baseUrl: "http://127.0.0.1:8700/v1",
      input: ["text"],
      contextWindow: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    classifiers: { "typesafe-system-one": { classify } },
  });
}
