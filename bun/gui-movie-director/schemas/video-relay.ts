import type { UnifiedCommand } from "./types";

export const videoRelayCommand: UnifiedCommand = {
  action: "video-relay",
  submitLabel: "Relay Video",
  runningLabel: "Relaying...",
  fields: [
    { key: "relay_prompts", cliFlag: "--relay-prompts", control: "images" },
    { key: "relay_preset", cliFlag: "--relay-preset", control: "text", label: "Relay Preset" },
    { key: "relay_variant", cliFlag: "--relay-variant", control: "text", label: "Relay Variant" },
    { key: "relay_first_image", cliFlag: "--relay-first-image", control: "image", label: "Relay First Image" },
    { key: "relay_images", cliFlag: "--relay-images", control: "text", label: "Relay Images" },
    { key: "relay_audio", cliFlag: "--relay-audio", control: "text", label: "Relay Audio" },
    { key: "relay_audio_mode", cliFlag: "--relay-audio-mode", control: "select", label: "Audio Mode", choices: [
      { value: "replace", label: "Replace" },
      { value: "mix", label: "Mix" },
      { value: "keep", label: "Keep" },
    ], default: "replace" },
    { key: "relay_duration", cliFlag: "--relay-duration", control: "number", label: "Duration", default: 8.0 },
    { key: "relay_output", cliFlag: "--relay-output", control: "text", label: "Output" },
    { key: "width", cliFlag: "--width", control: "number", label: "Width", default: 704 },
    { key: "height", cliFlag: "--height", control: "number", label: "Height", default: 448 },
    { key: "fps", cliFlag: "--fps", control: "number", label: "FPS", default: 24 },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42 },
    { key: "cfg_scale", cliFlag: "--cfg-scale", control: "number", label: "CFG Scale", default: 1.0 },
    { key: "stg_scale", cliFlag: "--stg-scale", control: "number", label: "STG Scale", default: 0.0 },
    { key: "stage1_steps", cliFlag: "--stage1-steps", control: "number", label: "Stage 1 Steps", default: 8 },
    { key: "stage2_steps", cliFlag: "--stage2-steps", control: "number", label: "Stage 2 Steps", default: 3 },
    { key: "low_ram", cliFlag: "--low-ram", control: "toggle", label: "Low RAM" },
    { key: "distilled", cliFlag: "--distilled", control: "toggle", label: "Distilled" },
    { key: "lora_path", cliFlag: "--lora-path", control: "text", label: "LoRA Path" },
    { key: "lora_scale", cliFlag: "--lora-scale", control: "range", label: "LoRA Scale", default: 1.0 },
  ],
};
