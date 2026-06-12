import type { CommandSchema } from "./shared";
import { SEED, LORA_PATH, LORA_SCALE } from "./shared";

export const videoRelay: CommandSchema = {
  // Prompt input
  relay_prompts: { type: "multiselect", cliFlag: "--relay-prompts" },  // array of prompt strings
  relay_preset: { type: "string", cliFlag: "--relay-preset" },
  relay_variant: { type: "string", cliFlag: "--relay-variant" },

  // Images
  relay_first_image: { type: "string", cliFlag: "--relay-first-image" },
  relay_images: { type: "string", cliFlag: "--relay-images" },

  // Audio
  relay_audio: { type: "string", cliFlag: "--relay-audio" },
  relay_audio_mode: { type: "select", cliFlag: "--relay-audio-mode", choices: ["replace", "mix", "keep"], default: "replace" },

  // Timing
  relay_duration: { type: "number", cliFlag: "--relay-duration", default: 8.0 },

  // Output
  relay_output: { type: "string", cliFlag: "--relay-output" },

  // Generation
  width: { type: "number", cliFlag: "--width", default: 704 },
  height: { type: "number", cliFlag: "--height", default: 448 },
  fps: { type: "number", cliFlag: "--fps", default: 24 },
  seed: SEED,
  cfg_scale: { type: "number", cliFlag: "--cfg-scale", default: 1.0 },
  stg_scale: { type: "number", cliFlag: "--stg-scale", default: 0.0 },
  stage1_steps: { type: "number", cliFlag: "--stage1-steps", default: 8 },
  stage2_steps: { type: "number", cliFlag: "--stage2-steps", default: 3 },

  // Quality
  low_ram: { type: "boolean", cliFlag: "--low-ram" },
  distilled: { type: "boolean", cliFlag: "--distilled" },

  // LoRA
  lora_path: LORA_PATH,
  lora_scale: LORA_SCALE,
};
