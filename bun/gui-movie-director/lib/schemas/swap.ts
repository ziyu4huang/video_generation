import type { CommandSchema } from "./shared";
import { INPUT_IMAGE } from "./shared";

export const swap: CommandSchema = {
  input_image: { ...INPUT_IMAGE, required: true },
  reference: { type: "string", cliFlag: "--reference", required: true },
  sam_prompt: { type: "string", cliFlag: "--sam-prompt", required: true },
  ref_sam_prompt: { type: "string", cliFlag: "--ref-sam-prompt" },
  sam_threshold: { type: "number", cliFlag: "--sam-threshold", default: 0.3, min: 0, max: 1 },
  feather: { type: "number", cliFlag: "--feather", default: 10 },
  blend: { type: "boolean", cliFlag: "--blend" },
};
