import type { CommandSchema } from "./shared";
import { PROMPT, STEPS, SEED, INPUT_IMAGE, DENOISE, PIPELINE } from "./shared";

export const imageRestore: CommandSchema = {
  input_image: { ...INPUT_IMAGE, required: true },
  prompt: PROMPT,
  denoise_strength: { ...DENOISE, default: 0.35 },
  pipeline: PIPELINE,
  steps: STEPS,
  seed: SEED,
};
