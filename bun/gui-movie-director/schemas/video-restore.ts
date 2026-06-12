import type { UnifiedCommand } from "./types";

export const videoRestoreCommand: UnifiedCommand = {
  action: "video-restore",
  submitLabel: "Restore Video",
  runningLabel: "Restoring...",
  fields: [
    { key: "restore_input_flag", cliFlag: "--restore-input", control: "text", label: "Restore Input", required: true },
    { key: "restore_output", cliFlag: "--restore-output", control: "text", label: "Restore Output" },
    { key: "restore_negative_prompt", cliFlag: "--restore-negative-prompt", control: "text", label: "Negative Prompt" },
    { key: "restore_scale", cliFlag: "--restore-scale", control: "range", label: "Restore Scale", default: 1.0 },
    { key: "restore_cond_strength", cliFlag: "--restore-cond-strength", control: "range", label: "Condition Strength", default: 1.0, min: 0, max: 1 },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42 },
    { key: "frames", cliFlag: "--frames", control: "number", label: "Frames" },
    { key: "low_ram", cliFlag: "--low-ram", control: "toggle", label: "Low RAM" },
    { key: "restoration_lora", cliFlag: "--restoration-lora", control: "text", label: "Restoration LoRA" },
    { key: "upscale_lora", cliFlag: "--upscale-lora", control: "text", label: "Upscale LoRA" },
    { key: "restoration_scale", cliFlag: "--restoration-scale", control: "range", label: "Restoration Scale", default: 1.0 },
    { key: "upscale_scale", cliFlag: "--upscale-scale", control: "range", label: "Upscale Scale", default: 1.0 },
    { key: "no_upscale_lora", cliFlag: "--no-upscale-lora", control: "toggle", label: "No Upscale LoRA" },
    { key: "restore_no_audio", cliFlag: "--restore-no-audio", control: "toggle", label: "No Audio" },
  ],
};
