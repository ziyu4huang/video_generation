import type { UnifiedCommand } from "./types";
import { T2I_PIPELINE_OPTIONS, RESOLUTION_CHOICES } from "./shared";

export const t2iCommand: UnifiedCommand = {
  action: "t2i",
  submitLabel: "Generate",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  fields: [
    { key: "prompt", cliFlag: "--prompt", control: "prompt", required: true, placeholder: "Describe the image you want to generate...", section: "Prompt" },
    { key: "pipeline", cliFlag: "--pipeline", control: "select", label: "Pipeline", choices: T2I_PIPELINE_OPTIONS, default: "zimage", section: "Generation" },
    // Resolution picker — a "WxH" key (UI-only, no CLI flag). The key expands to
    // width/height, which is what run.py receives. Switching pipeline auto-selects
    // the per-model preference (lens→1024², zimage/flux2-klein→640×960).
    { key: "resolution", control: "select", label: "Resolution", choices: RESOLUTION_CHOICES, default: "640x960", section: "Generation" },
    // Steps is hidden on purpose: each pipeline has its own optimized step count,
    // resolved server-side via _PIPELINE_DEFAULT_STEPS (zimage=9, flux2-klein=4,
    // lens=20). There's nothing for the user to tune — the value just tracks the
    // chosen model — so buildParams never sends --steps either.
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 50, section: "Generation", visible: () => false },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Generation" },
    { key: "width", cliFlag: "--width", control: "number", label: "Width", min: 256, max: 2048, step: 64, default: 640, section: "Generation", visible: (s) => s.resolution === "custom" },
    { key: "height", cliFlag: "--height", control: "number", label: "Height", min: 256, max: 2048, step: 64, default: 960, section: "Generation", visible: (s) => s.resolution === "custom" },
    { key: "count", cliFlag: "--count", control: "number", label: "Count", min: 1, max: 10, default: 1, section: "Generation" },
    // Multi-LoRA editor (UI-only). buildParams derives lora_path/lora_scale
    // arrays → repeated --lora-path / --lora-scale flags (multiselect backend fields).
    { key: "loras", control: "loras", label: "LoRAs", default: [], section: "LoRA & Style" },
    { key: "draft", cliFlag: "--draft", control: "toggle", label: "Draft mode (fewer steps, smaller resolution)", section: "Options" },
    { key: "upscale", cliFlag: "--upscale", control: "toggle", label: "ESRGAN 4× Upscale", section: "Options" },
    // Backend-only fields (no section → not shown in form)
    { key: "lora_path", cliFlag: "--lora-path", control: "multiselect", label: "LoRA Paths" },
    { key: "lora_scale", cliFlag: "--lora-scale", control: "multiselect", label: "LoRA Scales" },
    { key: "vae_path", cliFlag: "--vae-path", control: "text", label: "VAE Path" },
    { key: "variant", cliFlag: "--variant", control: "select", label: "Variant", choices: [{ value: "4b", label: "4B" }, { value: "9b", label: "9B" }] },
    { key: "upscale_method", cliFlag: "--upscale-method", control: "select", label: "Upscale Method", choices: [{ value: "esrgan", label: "ESRGAN" }, { value: "seedvr2", label: "SeedVR2" }] },
    { key: "seed_start", cliFlag: "--seed-start", control: "number", label: "Seed Start" },
  ],
  buildParams: (s) => {
    const loras = Array.isArray(s.loras) ? s.loras.filter((r: any) => r?.path) : [];
    return {
      prompt: s.prompt?.trim(),
      pipeline: s.pipeline,
      width: s.width,
      height: s.height,
      // steps intentionally omitted — server picks the per-pipeline optimum.
      seed: s.seed,
      // Multi-LoRA: derive repeated --lora-path / --lora-scale from the editor
      // rows. Empty → both undefined → omitted (no LoRA).
      lora_path: loras.length ? loras.map((r: any) => r.path) : undefined,
      lora_scale: loras.length ? loras.map((r: any) => Number(r.scale ?? 1.0).toFixed(2)) : undefined,
      draft: s.draft || undefined,
      upscale: s.upscale || undefined,
      count: s.count > 1 ? s.count : undefined,
    };
  },
};
