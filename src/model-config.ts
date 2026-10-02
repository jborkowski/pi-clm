import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_REPO, getDefaultStateDir } from "./model-manager.ts";

export const CONFIG_FILENAME = "config.json";

/**
 * A quantization variant of a CLM model published on the HF hub.
 *
 * Memory figures are approximate and come from the mlx-community model cards.
 */
export interface QuantizationVariant {
  /** Short id used in the saved config (e.g. "4bit"). */
  id: string;
  /** Full HF repo id for this variant. */
  repo: string;
  /** Quantization bit width of this variant's checkpoint. */
  bits: number;
  /** Human-readable label for menus. */
  label: string;
  /** Approximate download size of the weights. */
  weightsSize: string;
  /** Approximate peak memory while serving. */
  peakMemory: string;
  /** Extra note shown in the menu (accuracy caveats etc.). */
  note?: string;
  /** Whether this is the recommended default for memory-constrained Macs. */
  recommended?: boolean;
}

/** A selectable CLM model with its available quantization variants. */
export interface ModelChoice {
  /** Short id used in the saved config (e.g. "CLM-v0.1-8B"). */
  id: string;
  /** Human-readable label for menus. */
  label: string;
  variants: QuantizationVariant[];
}

export const MODELS: ModelChoice[] = [
  {
    id: "CLM-v0.1-8B",
    label: "CLM v0.1 8B",
    variants: [
      {
        id: "4bit",
        repo: "mlx-community/CLM-v0.1-8B-MLX-4bit",
        bits: 4,
        label: "4-bit",
        weightsSize: "~4.7 GB",
        peakMemory: "~5.5 GB peak (16 GB Macs recommended)",
        note: "Approximate: 91.4% same-top-option vs 8-bit, rising to 99.3% when the model is at least 70% confident. Borderline decisions can occasionally flip.",
        recommended: true,
      },
      {
        id: "5bit",
        repo: "mlx-community/CLM-v0.1-8B-MLX-5bit",
        bits: 5,
        label: "5-bit",
        weightsSize: "~6 GB",
        peakMemory: "~7 GB peak (estimated)",
        note: "Listed in the community index; details unverified.",
      },
      {
        id: "8bit",
        repo: DEFAULT_REPO,
        bits: 8,
        label: "8-bit",
        weightsSize: "~8 GB",
        peakMemory: "~9 GB peak",
        note: "Highest accuracy: 99.0% agreement with the full-precision model (essentially upstream-noise level).",
      },
    ],
  },
];

export interface ClmConfig {
  modelId: string;
  quantizationId: string;
}

/** One rendered menu line for a variant. */
export function formatVariantLine(model: ModelChoice, variant: QuantizationVariant): string {
  const flag = variant.recommended ? " (recommended for memory-constrained Macs)" : "";
  const note = variant.note ? ` — ${variant.note}` : "";
  return `${model.label} ${variant.label}${flag}: ${variant.weightsSize} download, ${variant.peakMemory}${note}`;
}

export function findModel(modelId: string): ModelChoice | undefined {
  return MODELS.find((m) => m.id === modelId);
}

export function findVariant(model: ModelChoice, quantizationId: string): QuantizationVariant | undefined {
  return model.variants.find((v) => v.id === quantizationId);
}

/** Resolve a saved config to its HF repo id. */
export function configToRepo(config: ClmConfig | null | undefined): string | undefined {
  if (!config) return undefined;
  const model = findModel(config.modelId);
  if (!model) return undefined;
  const variant = findVariant(model, config.quantizationId);
  return variant?.repo;
}

/**
 * Quantization bit width of a published variant's checkpoint, or undefined
 * when the repo is not a variant of any model in MODELS.
 */
export function repoQuantizationBits(repo: string): number | undefined {
  for (const model of MODELS) {
    for (const variant of model.variants) {
      if (variant.repo === repo) return variant.bits;
    }
  }
  return undefined;
}

export function getConfigPath(stateDir?: string): string {
  return path.join(stateDir ?? getDefaultStateDir(), CONFIG_FILENAME);
}

/**
 * Read the persisted model/quantization choice.
 * Returns null when no choice has been made yet (first use), leaving
 * all existing defaults untouched.
 */
export async function loadConfig(stateDir?: string): Promise<ClmConfig | null> {
  try {
    const raw = await fsp.readFile(getConfigPath(stateDir), "utf-8");
    const parsed = JSON.parse(raw) as ClmConfig;
    if (typeof parsed?.modelId === "string" && typeof parsed?.quantizationId === "string") {
      return { modelId: parsed.modelId, quantizationId: parsed.quantizationId };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the model/quantization choice for later sessions. */
export async function saveConfig(config: ClmConfig, stateDir?: string): Promise<void> {
  const dir = stateDir ?? getDefaultStateDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, CONFIG_FILENAME);
  const tempPath = `${file}.tmp-${Date.now()}`;
  await fsp.writeFile(tempPath, JSON.stringify(config, null, 2), "utf-8");
  await fsp.rename(tempPath, file);
}

/**
 * Effective repo id: the saved choice when valid, otherwise the existing
 * default (kept untouched when the menu was never opened).
 */
export function resolveRepo(config: ClmConfig | null | undefined): string {
  return configToRepo(config) ?? DEFAULT_REPO;
}
