import type { CommandSchema } from "./shared";
import { PROMPT, STEPS, SEED, INPUT_IMAGE } from "./shared";

export const expansion: CommandSchema = {
  input_image: { ...INPUT_IMAGE, required: true },
  expand: { type: "string", cliFlag: "--expand" },
  pixels: { type: "number", cliFlag: "--pixels", default: 1024 },
  aspect: { type: "string", cliFlag: "--aspect" },
  expansion_feather: { type: "number", cliFlag: "--expansion-feather", default: 96 },
  overlap: { type: "number", cliFlag: "--overlap", default: 128 },
  longest: { type: "number", cliFlag: "--longest", default: 1024 },
  expansion_ref_strength: { type: "number", cliFlag: "--expansion-ref-strength", default: 1.0, min: 0, max: 1 },
  prompt: PROMPT,
  steps: STEPS,
  seed: SEED,
  upscale: { type: "boolean", cliFlag: "--upscale" },
  upscale_method: { type: "select", cliFlag: "--upscale-method", choices: ["esrgan", "seedvr2"] },
};
