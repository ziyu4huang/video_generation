import type { CommandSchema } from "./shared";
import { PROMPT, STEPS, SEED, INPUT_IMAGE, PIPELINE } from "./shared";

export const controlnet: CommandSchema = {
  prompt: { ...PROMPT, required: true },
  input_image: INPUT_IMAGE,
  controlnet_type: { type: "select", cliFlag: "--controlnet-type", choices: ["canny", "pose", "depth", "hed", "scribble", "gray"], default: "canny" },
  controlnet_strength: { type: "number", cliFlag: "--controlnet-strength", default: 1.0, min: 0, max: 1 },
  blur_ref: { type: "boolean", cliFlag: "--blur-ref" },
  remove_outlines: { type: "boolean", cliFlag: "--remove-outlines" },
  steps: STEPS,
  seed: SEED,
  pipeline: PIPELINE,
};
