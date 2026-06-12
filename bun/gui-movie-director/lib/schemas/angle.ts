import type { CommandSchema } from "./shared";
import { PROMPT, INPUT_IMAGE } from "./shared";

export const angle: CommandSchema = {
  input_image: { ...INPUT_IMAGE, required: true },
  azimuth: { type: "number", cliFlag: "--azimuth", default: 90 },
  elevation: { type: "number", cliFlag: "--elevation", default: 0 },
  prompt: PROMPT,
};
