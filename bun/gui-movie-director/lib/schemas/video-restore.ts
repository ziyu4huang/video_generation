import type { CommandSchema } from "./shared";
import { SEED } from "./shared";

export const videoRestore: CommandSchema = {
  restore_input_flag: { type: "string", cliFlag: "--restore-input", required: true },
  restore_output: { type: "string", cliFlag: "--restore-output" },
  restore_negative_prompt: { type: "string", cliFlag: "--restore-negative-prompt" },
  restore_scale: { type: "number", cliFlag: "--restore-scale", default: 1.0 },
  restore_cond_strength: { type: "number", cliFlag: "--restore-cond-strength", default: 1.0, min: 0, max: 1 },
  seed: SEED,
  frames: { type: "number", cliFlag: "--frames" },
  low_ram: { type: "boolean", cliFlag: "--low-ram" },
  restoration_lora: { type: "string", cliFlag: "--restoration-lora" },
  upscale_lora: { type: "string", cliFlag: "--upscale-lora" },
  restoration_scale: { type: "number", cliFlag: "--restoration-scale", default: 1.0 },
  upscale_scale: { type: "number", cliFlag: "--upscale-scale", default: 1.0 },
  no_upscale_lora: { type: "boolean", cliFlag: "--no-upscale-lora" },
  restore_no_audio: { type: "boolean", cliFlag: "--restore-no-audio" },
};
