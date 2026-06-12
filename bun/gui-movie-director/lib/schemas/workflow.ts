import type { CommandSchema } from "./shared";
import { PROMPT, SEED, PIPELINE } from "./shared";

export const workflow: CommandSchema = {
  prompt: { ...PROMPT, required: true },
  pipeline: PIPELINE,
  width: { type: "number", cliFlag: "--width", default: 640 },
  height: { type: "number", cliFlag: "--height", default: 960 },
  seed: SEED,
  face_detail: { type: "boolean", cliFlag: "--face-detail" },
  face_detail_denoise: { type: "number", cliFlag: "--face-detail-denoise" },
  face_detail_steps: { type: "number", cliFlag: "--face-detail-steps" },
  film_grain: { type: "number", cliFlag: "--film-grain" },
  sharpening: { type: "number", cliFlag: "--sharpening" },
  lut: { type: "string", cliFlag: "--lut" },
  lut_strength: { type: "number", cliFlag: "--lut-strength" },
  skin_contrast: { type: "number", cliFlag: "--skin-contrast" },
  upscale: { type: "boolean", cliFlag: "--upscale" },
};
