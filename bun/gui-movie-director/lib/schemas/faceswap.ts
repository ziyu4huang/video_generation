import type { CommandSchema } from "./shared";
import { SEED, INPUT_IMAGE } from "./shared";

export const faceswap: CommandSchema = {
  input_image: { ...INPUT_IMAGE, required: true },
  face: { type: "string", cliFlag: "--face", required: true },
  mode: { type: "select", cliFlag: "--mode", choices: ["face", "head"], default: "head" },
  lora: { type: "string", cliFlag: "--lora" },
  seed: SEED,
};
