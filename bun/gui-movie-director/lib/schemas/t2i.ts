import type { CommandSchema } from "./shared";
import { PROMPT, STEPS, SEED, LORA_PATH, LORA_SCALE, VAE_PATH, PIPELINE } from "./shared";

export const t2i: CommandSchema = {
  prompt: { ...PROMPT, required: true },
  pipeline: PIPELINE,
  width: { type: "number", cliFlag: "--width", default: 640 },
  height: { type: "number", cliFlag: "--height", default: 960 },
  steps: STEPS,
  seed: SEED,
  lora_path: LORA_PATH,
  lora_scale: LORA_SCALE,
  vae_path: VAE_PATH,
  variant: { type: "select", cliFlag: "--variant", choices: ["4b", "9b"] },
  draft: { type: "boolean", cliFlag: "--draft" },
  upscale: { type: "boolean", cliFlag: "--upscale" },
  upscale_method: { type: "select", cliFlag: "--upscale-method", choices: ["esrgan", "seedvr2"] },
  count: { type: "number", cliFlag: "--count", default: 1, min: 1 },
  seed_start: { type: "number", cliFlag: "--seed-start" },
};
