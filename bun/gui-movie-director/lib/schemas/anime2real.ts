import type { CommandSchema } from "./shared";
import { PROMPT, STEPS, SEED, INPUT_IMAGE } from "./shared";

export const anime2real: CommandSchema = {
  input_image: { ...INPUT_IMAGE, required: true },
  realism_style: { type: "select", cliFlag: "--realism-style", choices: ["civitai-chinese", "photorealistic", "3d-game", "semi-realistic"], default: "civitai-chinese" },
  anime2real_lora_scale: { type: "number", cliFlag: "--anime2real-lora-scale", min: 0, max: 2 },
  anime2real_ref_count: { type: "number", cliFlag: "--anime2real-ref-count", default: 1, min: 1, max: 4 },
  ref_strength: { type: "number", cliFlag: "--ref-strength", default: 1.0, min: 0, max: 1 },
  prompt: PROMPT,
  steps: STEPS,
  seed: SEED,
};
