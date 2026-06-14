import type { UnifiedCommand } from "./types";

export const videoVbvrCommand: UnifiedCommand = {
  action: "video-vbvr",
  submitLabel: "Generate VBVR",
  runningLabel: "Generating VBVR...",
  fields: [
    // Core
    { key: "prompt", cliFlag: "--prompt", control: "prompt", label: "Prompt", required: true },
    { key: "input_image", cliFlag: "--input-image", control: "image", label: "Input Image",
      placeholder: "Reference image for I2V mode" },
    // VBVR-specific
    { key: "vbvr_lora", cliFlag: "--vbvr-lora", control: "text", label: "VBVR LoRA Path",
      placeholder: "Auto-detected from models/lora/ if omitted" },
    // Video generation params (shared)
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42 },
    { key: "width", cliFlag: "--width", control: "number", label: "Width", default: 704 },
    { key: "height", cliFlag: "--height", control: "number", label: "Height", default: 448 },
    { key: "frames", cliFlag: "--frames", control: "number", label: "Frames", default: 97 },
    { key: "fps", cliFlag: "--fps", control: "number", label: "FPS", default: 24 },
    { key: "cfg_scale", cliFlag: "--cfg-scale", control: "number", label: "CFG Scale", default: 5.0 },
    { key: "stg_scale", cliFlag: "--stg-scale", control: "number", label: "STG Scale", default: 1.0 },
    { key: "stage1_steps", cliFlag: "--stage1-steps", control: "number", label: "Stage 1 Steps", default: 8 },
    { key: "stage2_steps", cliFlag: "--stage2-steps", control: "number", label: "Stage 2 Steps", default: 3 },
    // Performance / quality toggles
    { key: "low_ram", cliFlag: "--low-ram", control: "toggle", label: "Low RAM" },
    { key: "hq", cliFlag: "--hq", control: "toggle", label: "HQ (slowest, best quality)" },
    { key: "teacache", cliFlag: "--teacache", control: "toggle", label: "TeaCache (speedup)" },
    // LoRA scale (inherited shared arg)
    { key: "lora_scale", cliFlag: "--lora-scale", control: "range", label: "VBVR LoRA Scale", default: 1.0, min: 0, max: 2 },
  ],
};
