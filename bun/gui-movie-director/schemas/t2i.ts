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
    // Transformer instance (models/transformer/*). Choices are loaded DYNAMICALLY from
    // run.py (serverDefaults.transformers) — never hardcoded — and filtered by the
    // selected pipeline. Per-transformer built-in params (e.g. dark-beast-dbzit9 →
    // cfg_scale 3.0) are applied on selection via serverDefaults.transformer_defaults.
    { key: "transformer", cliFlag: "--transformer", control: "select", choicesFrom: "transformers", label: "Transformer", default: "zimage-moody-v126", section: "Generation", visible: (s) => s.pipeline === "zimage" || s.pipeline === "flux2-klein" || s.pipeline === "auto" },
    // Resolution picker — a "WxH" key (UI-only, no CLI flag). The key expands to
    // width/height, which is what run.py receives. Switching pipeline auto-selects
    // the per-model preference (lens→1024², zimage/flux2-klein→640×960).
    { key: "resolution", control: "select", label: "Resolution", choices: RESOLUTION_CHOICES, default: "640x960", section: "Generation" },
    // Steps is hidden on purpose: each pipeline has its own optimized step count,
    // resolved server-side via _PIPELINE_DEFAULT_STEPS (zimage=9, flux2-klein=4,
    // lens=20). There's nothing for the user to tune — the value just tracks the
    // chosen model — so buildParams never sends --steps either.
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 50, section: "Generation", visible: () => false },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, compact: true, section: "Generation" },
    { key: "width", cliFlag: "--width", control: "number", label: "Width", min: 256, max: 2560, step: 64, default: 640, section: "Generation", visible: (s) => s.resolution === "custom" },
    { key: "height", cliFlag: "--height", control: "number", label: "Height", min: 256, max: 2560, step: 64, default: 960, section: "Generation", visible: (s) => s.resolution === "custom" },
    { key: "count", cliFlag: "--count", control: "number", label: "Count", min: 1, max: 10, default: 1, compact: true, section: "Generation" },
    // CFG scale (zimage only). Empty = off (single forward). Selecting a transformer
    // with a registered default (e.g. dark-beast-dbzit9) auto-fills this; the user
    // can still override. buildParams omits it when empty so the server treats it as off.
    { key: "cfg_scale", cliFlag: "--cfg-scale", control: "number", label: "CFG Scale", min: 1, max: 8, step: 0.5, placeholder: "off (default)", compact: true, section: "Generation", visible: (s) => s.pipeline === "zimage" },
    // Multi-LoRA editor (UI-only). buildParams derives lora_path/lora_scale
    // arrays → repeated --lora-path / --lora-scale flags (multiselect backend fields).
    // Microsoft Lens is a separate model family with no LoRA support — hide
    // the editor entirely when it's selected (see PIPELINE_TO_LORA_TAGS).
    { key: "loras", control: "loras", label: "LoRAs", default: [], section: "LoRA & Style", visible: (s) => s.pipeline !== "lens" },
    { key: "draft", cliFlag: "--draft", control: "toggle", label: "Draft mode (fewer steps, smaller resolution)", section: "Options" },
    { key: "upscale", cliFlag: "--upscale", control: "toggle", label: "ESRGAN 4× Upscale", section: "Options" },
    // VAE selector — dynamically populated from serverDefaults.vaes (models/vae/*/manifest.json).
    // Filtered by selected pipeline (same mechanism as Transformer dropdown).
    // Empty value ("Default") means no --vae-path sent; server uses the pipeline's built-in VAE.
    // Lens uses its own fixed VAE internally — hide the picker for it.
    { key: "vae_path", cliFlag: "--vae-path", control: "select", choicesFrom: "vaes", label: "VAE", default: "", section: "Generation", visible: (s) => s.pipeline !== "lens" },
    // Backend-only fields (no section → not shown in form)
    { key: "lora_path", cliFlag: "--lora-path", control: "multiselect", label: "LoRA Paths" },
    { key: "lora_scale", cliFlag: "--lora-scale", control: "multiselect", label: "LoRA Scales" },
    { key: "variant", cliFlag: "--variant", control: "select", label: "Variant", choices: [{ value: "4b", label: "4B" }, { value: "9b", label: "9B" }] },
    { key: "upscale_method", cliFlag: "--upscale-method", control: "select", label: "Upscale Method", choices: [{ value: "esrgan", label: "ESRGAN" }, { value: "seedvr2", label: "SeedVR2" }] },
    { key: "seed_start", cliFlag: "--seed-start", control: "number", label: "Seed Start" },
  ],
  buildParams: (s) => {
    const loras = Array.isArray(s.loras) ? s.loras.filter((r: any) => r?.path) : [];
    return {
      prompt: s.prompt?.trim(),
      pipeline: s.pipeline,
      transformer: (s.pipeline === "zimage" || s.pipeline === "flux2-klein" || s.pipeline === "auto") ? s.transformer : undefined,
      width: s.width,
      height: s.height,
      // steps intentionally omitted — server picks the per-pipeline optimum.
      seed: s.seed,
      // CFG: only send when the user/transformer-default set a value (zimage).
      // Empty → undefined → server treats as off (single forward/step).
      cfg_scale: s.cfg_scale != null && s.cfg_scale !== "" ? s.cfg_scale : undefined,
      // Multi-LoRA: derive repeated --lora-path / --lora-scale from the editor
      // rows. Empty → both undefined → omitted (no LoRA).
      lora_path: loras.length ? loras.map((r: any) => r.path) : undefined,
      lora_scale: loras.length ? loras.map((r: any) => Number(r.scale ?? 1.0).toFixed(2)) : undefined,
      vae_path: s.vae_path || undefined,
      draft: s.draft || undefined,
      upscale: s.upscale || undefined,
      count: s.count > 1 ? s.count : undefined,
    };
  },
};
