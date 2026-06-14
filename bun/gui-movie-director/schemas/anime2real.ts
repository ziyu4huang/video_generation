import type { UnifiedCommand } from "./types";

export const anime2realCommand: UnifiedCommand = {
  action: "anime2real",
  submitLabel: "Convert to Real",
  runningLabel: "Converting...",
  isDisabled: (s) => !s.input_image,
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Anime Image", required: true, section: "Input" },
    { key: "realism_style", cliFlag: "--realism-style", control: "select", label: "Realism Style", choices: [
      { value: "civitai-chinese", label: "CivitAI Chinese (Recommended)" },
      { value: "photorealistic", label: "Photorealistic" },
      { value: "3d-game", label: "3D Game" },
      { value: "semi-realistic", label: "Semi-Realistic" },
    ], default: "civitai-chinese", section: "Style Transfer" },
    { key: "anime2real_lora_scale", cliFlag: "--anime2real-lora-scale", control: "range", label: "LoRA Scale (built-in default)", min: 0, max: 1, step: 0.05, default: 1.0, section: "Style Transfer" },
    // Multi-LoRA editor. User picks REPLACE the built-in default LoRA; empty
    // list → backend uses the built-in _DEFAULT_LORA at the scale above.
    { key: "loras", control: "loras", label: "LoRAs (override default)", default: [], section: "Style Transfer" },
    { key: "ref_strength", cliFlag: "--ref-strength", control: "range", label: "Reference Strength", min: 0, max: 1, step: 0.05, default: 1.0, section: "Style Transfer" },
    { key: "anime2real_ref_count", cliFlag: "--anime2real-ref-count", control: "number", label: "Reference Count", min: 1, max: 4, default: 1, section: "Style Transfer" },
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 50, default: 8, section: "Style Transfer" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Style Transfer" },
    // Backend-only (no section) — multiselect so buildCliArgs emits repeated
    // --lora-path / --lora-scale when the loras editor is non-empty.
    { key: "lora_path", cliFlag: "--lora-path", control: "multiselect", label: "LoRA Paths" },
    { key: "lora_scale", cliFlag: "--lora-scale", control: "multiselect", label: "LoRA Scales" },
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Prompt" },
  ],
  buildParams: (s) => {
    const loras = Array.isArray(s.loras) ? s.loras.filter((r: any) => r?.path) : [];
    return {
      input_image: s.input_image,
      realism_style: s.realism_style,
      // User LoRAs replace the built-in default → emit multi flags. Empty list
      // → backend falls back to _DEFAULT_LORA at the scale above.
      ...(loras.length
        ? {
            lora_path: loras.map((r: any) => r.path),
            lora_scale: loras.map((r: any) => Number(r.scale ?? 1.0).toFixed(2)),
          }
        : {
            anime2real_lora_scale: s.anime2real_lora_scale !== 1.0 ? s.anime2real_lora_scale : undefined,
          }),
      ref_strength: s.ref_strength !== 1.0 ? s.ref_strength : undefined,
      anime2real_ref_count: s.anime2real_ref_count !== 1 ? s.anime2real_ref_count : undefined,
      steps: s.steps,
      seed: s.seed,
    };
  },
};
