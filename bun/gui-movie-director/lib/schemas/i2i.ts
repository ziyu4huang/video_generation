import type { CommandSchema } from "./shared";
import { PROMPT, STEPS, SEED, LORA_PATH, LORA_SCALE, INPUT_IMAGE, DENOISE, PIPELINE } from "./shared";

export const i2i: CommandSchema = {
  input_image: { ...INPUT_IMAGE, required: true },
  reference_image: { type: "string", cliFlag: "--reference-image" },
  prompt: PROMPT,
  denoise_strength: { ...DENOISE, default: 0.4 },
  controlnet_strength: { type: "number", cliFlag: "--controlnet-strength", default: 1.0, min: 0, max: 1 },
  pipeline: PIPELINE,
  steps: STEPS,
  seed: SEED,
  skip_preprocess: { type: "boolean", cliFlag: "--skip-preprocess" },
  blur_ref: { type: "boolean", cliFlag: "--blur-ref" },
  lora_path: LORA_PATH,
  lora_scale: LORA_SCALE,
  upscale: { type: "boolean", cliFlag: "--upscale" },
};
