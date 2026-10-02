import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  MODELS,
  findModel,
  findVariant,
  formatVariantLine,
  configToRepo,
  loadConfig,
  saveConfig,
  resolveRepo,
  getConfigPath,
  CONFIG_FILENAME,
} from "../src/model-config.ts";
import { DEFAULT_REPO } from "../src/model-manager.ts";
import { ServerManager } from "../src/server-manager.ts";

function tempStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-clm-config-test-"));
}

test("catalog exposes 4-bit, 5-bit and 8-bit variants for CLM-v0.1-8B", () => {
  const model = findModel("CLM-v0.1-8B");
  assert.ok(model);
  const ids = model.variants.map((v) => v.id).sort();
  assert.deepEqual(ids, ["4bit", "5bit", "8bit"]);
  const fourBit = findVariant(model, "4bit");
  assert.ok(fourBit?.recommended);
  assert.equal(fourBit.repo, "mlx-community/CLM-v0.1-8B-MLX-4bit");
  assert.match(fourBit.note ?? "", /91\.4%/);
  const eightBit = findVariant(model, "8bit");
  assert.equal(eightBit?.repo, DEFAULT_REPO);
});

test("menu line mentions memory footprint and accuracy caveat for 4-bit", () => {
  const model = MODELS[0];
  const line = formatVariantLine(model, findVariant(model, "4bit")!);
  assert.match(line, /4\.7 GB/);
  assert.match(line, /5\.5 GB/);
  assert.match(line, /91\.4%/);
  assert.match(line, /recommended/);
});

test("configToRepo resolves the saved choice to the variant repo", () => {
  assert.equal(configToRepo({ modelId: "CLM-v0.1-8B", quantizationId: "4bit" }), "mlx-community/CLM-v0.1-8B-MLX-4bit");
  assert.equal(configToRepo({ modelId: "CLM-v0.1-8B", quantizationId: "8bit" }), DEFAULT_REPO);
  assert.equal(configToRepo({ modelId: "unknown", quantizationId: "4bit" }), undefined);
  assert.equal(configToRepo(null), undefined);
});

test("loadConfig returns null before first use; saveConfig round-trips", async () => {
  const dir = await tempStateDir();
  assert.equal(await loadConfig(dir), null);

  await saveConfig({ modelId: "CLM-v0.1-8B", quantizationId: "4bit" }, dir);
  assert.deepEqual(await loadConfig(dir), { modelId: "CLM-v0.1-8B", quantizationId: "4bit" });

  // Round-trip after rewriting (atomic temp+rename path)
  await saveConfig({ modelId: "CLM-v0.1-8B", quantizationId: "8bit" }, dir);
  assert.deepEqual(await loadConfig(dir), { modelId: "CLM-v0.1-8B", quantizationId: "8bit" });
});

test("loadConfig tolerates corrupt config files", async () => {
  const dir = await tempStateDir();
  await fs.writeFile(getConfigPath(dir), "{not json", "utf-8");
  assert.equal(await loadConfig(dir), null);
});

test("resolveRepo keeps the existing default untouched when no choice was made", () => {
  assert.equal(resolveRepo(null), DEFAULT_REPO);
  assert.equal(resolveRepo(undefined), DEFAULT_REPO);
  assert.equal(resolveRepo({ modelId: "CLM-v0.1-8B", quantizationId: "4bit" }), "mlx-community/CLM-v0.1-8B-MLX-4bit");
});

test("ServerManager picks up the configured repo via setModelRepo", async () => {
  const dir = await tempStateDir();
  const manager = new ServerManager({ stateDir: dir });
  // No config: existing default stays untouched
  assert.equal(manager.getModelRepo(), DEFAULT_REPO);
  assert.equal(manager.getModelOptions().repo, DEFAULT_REPO);

  manager.setModelRepo("mlx-community/CLM-v0.1-8B-MLX-4bit");
  assert.equal(manager.getModelRepo(), "mlx-community/CLM-v0.1-8B-MLX-4bit");
  assert.equal(manager.getModelOptions().repo, "mlx-community/CLM-v0.1-8B-MLX-4bit");

  // Model path resolves against the configured repo's hub cache folder
  assert.match(manager.getModelPath(), /models--mlx-community--CLM-v0\.1-8B-MLX-4bit/);

  // Explicit modelRepo option still wins over the default
  const explicit = new ServerManager({ stateDir: dir, modelRepo: "mlx-community/CLM-v0.1-8B-MLX-5bit" });
  assert.equal(explicit.getModelRepo(), "mlx-community/CLM-v0.1-8B-MLX-5bit");
});
