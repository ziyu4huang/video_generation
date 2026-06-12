import type { UnifiedCommand } from "./types";

// Note: uses `input_image` key (matching CLI) instead of old frontend `body` key.
export const faceswapCommand: UnifiedCommand = {
  action: "faceswap",
  submitLabel: "Swap Face",
  runningLabel: "Swapping...",
  isDisabled: (s) => !s.input_image || !s.face,
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Body Image", required: true, section: "Images" },
    { key: "face", cliFlag: "--face", control: "image", label: "Face Image", required: true, section: "Images" },
    { key: "mode", cliFlag: "--mode", control: "select", label: "Mode", choices: [
      { value: "head", label: "Head Swap" },
      { value: "face", label: "Face Swap" },
    ], default: "head", section: "Settings" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Settings" },
    { key: "lora", cliFlag: "--lora", control: "text", label: "LoRA Path" },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    face: s.face,
    mode: s.mode,
    seed: s.seed,
  }),
};
