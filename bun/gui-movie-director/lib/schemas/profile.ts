import type { CommandSchema } from "./shared";
import { PROMPT, STEPS, SEED, LORA_PATH, LORA_SCALE, PIPELINE } from "./shared";

export const profile: CommandSchema = {
  prompt: { ...PROMPT, required: true },
  views: { type: "string", cliFlag: "--views", default: "front,back,side" },
  ratio: { type: "string", cliFlag: "--ratio", default: "standing" },
  base_prompt: { type: "string", cliFlag: "--base-prompt" },
  ref_count: { type: "number", cliFlag: "--ref-count", default: 3, min: 1, max: 4 },
  steps: STEPS,
  seed: SEED,
  pipeline: PIPELINE,
  lora_path: LORA_PATH,
  lora_scale: LORA_SCALE,
};
