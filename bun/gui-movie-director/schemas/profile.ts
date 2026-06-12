import type { UnifiedCommand } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

export const profileCommand: UnifiedCommand = {
  action: "profile",
  submitLabel: "Generate Profile",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  fields: [
    { key: "prompt", cliFlag: "--prompt", control: "prompt", required: true, placeholder: "Describe the character in detail...", section: "Character" },
    { key: "base_prompt", cliFlag: "--base-prompt", control: "text", label: "Base Prompt Override", placeholder: "Override the default photographic base prompt...", section: "Character" },
    { key: "views", cliFlag: "--views", control: "select", label: "Views", choices: [
      { value: "front,back,side", label: "All Views" },
      { value: "front", label: "Front Only" },
      { value: "front,back", label: "Front + Back" },
    ], default: "front,back,side", section: "Settings" },
    { key: "ratio", cliFlag: "--ratio", control: "select", label: "Pose", choices: [
      { value: "standing", label: "Standing" },
      { value: "sitting", label: "Sitting" },
    ], default: "standing", section: "Settings" },
    { key: "ref_count", cliFlag: "--ref-count", control: "number", label: "Reference Count", min: 1, max: 4, default: 3, section: "Settings" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Settings" },
    // Backend-only
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps" },
    { key: "pipeline", cliFlag: "--pipeline", control: "select", label: "Pipeline", choices: PIPELINE_OPTIONS, default: "zimage" },
    { key: "lora_path", cliFlag: "--lora-path", control: "text", label: "LoRA Path" },
    { key: "lora_scale", cliFlag: "--lora-scale", control: "range", label: "LoRA Scale", min: 0, max: 2, step: 0.05, default: 1.0 },
  ],
  buildParams: (s) => ({
    prompt: s.prompt?.trim(),
    views: s.views,
    ratio: s.ratio,
    base_prompt: s.base_prompt?.trim() || undefined,
    ref_count: s.ref_count !== 3 ? s.ref_count : undefined,
    seed: s.seed,
  }),
};
