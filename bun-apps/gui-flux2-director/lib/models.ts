/**
 * models.ts — scan the MLX models tree the same way the flux2 CLI resolves
 * it: `{modelsRoot}/{transformer|lora|upscale|vae|text_encoder|tokenizer}/<name>/`.
 * A directory only counts when it actually holds weights (≥1 .safetensors or
 * .gguf shard), so empty/placeholder dirs don't pollute the UI pickers.
 */
import { readdirSync, existsSync } from "fs";
import path from "path";

import { MODELS_DIR } from "./paths";

function hasWeights(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((e) => /\.(safetensors|gguf)$/i.test(e) && !e.startsWith("._"));
}

/** Names of weight-bearing subdirectories under `<modelsRoot>/<kind>/`. */
export function listModelNames(kind: string, modelsDir: string = MODELS_DIR): string[] {
  const root = path.join(modelsDir, kind);
  if (!existsSync(root)) return [];
  let dirents: string[];
  try {
    dirents = readdirSync(root);
  } catch {
    return [];
  }
  return dirents
    .filter((name) => !name.startsWith("."))
    .filter((name) => hasWeights(path.join(root, name)))
    .sort();
}

export interface ModelInventory {
  transformers: string[];
  loras: string[];
  upscaleModels: string[];
  vaes: string[];
  modelsDir: string;
}

export function scanModels(modelsDir: string = MODELS_DIR): ModelInventory {
  return {
    transformers: listModelNames("transformer", modelsDir),
    loras: listModelNames("lora", modelsDir),
    upscaleModels: listModelNames("upscale", modelsDir),
    vaes: listModelNames("vae", modelsDir),
    modelsDir,
  };
}
