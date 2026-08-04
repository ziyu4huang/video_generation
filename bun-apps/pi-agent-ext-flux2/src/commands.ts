/**
 * commands.ts — authoritative map of every `flux2` subcommand to its typed
 * parameters + CLI-flag translation.
 *
 * This file is the SINGLE source of truth for the tool's command surface. It is
 * curated against `swift/flux2-image-director/Sources/Flux2DirectorCLI/<Cmd>Command.swift`
 * and verified by `scripts/check-flags.ts` (run `flux2 <cmd> --help` and assert
 * every declared flag is modeled here or allow-listed).
 *
 * Naming: Swift `@Option var cfgScale` → CLI `--cfg-scale` (camelCase→kebab).
 * Defaults are intentionally NOT duplicated — `toArgs` only emits a flag when
 * the agent sets a value, so the Swift default always wins. This avoids drift.
 */
import { Type, type TSchema } from "typebox";

export type FieldType = "string" | "number" | "int" | "boolean" | "string[]" | "number[]";

export interface FieldSpec {
  /** CLI flag including dashes, e.g. "--ref", "--cfg-scale". Use "" for positional. */
  flag: string;
  type: FieldType;
  description: string;
  /** Value is a filesystem path → path-validated against allowed roots. */
  isPath?: boolean;
  /** Array field where every element is a path. */
  isPathArray?: boolean;
  /**
   * Value is a bare NAME the Swift binary joins onto a models-tree root
   * itself (e.g. `--transformer klein-9b` → `ModelPaths.transformerRoot
   * .appendingPathComponent(transformer)`), NOT a path the tool resolves.
   * The Swift side does this join with NO '..'-sanitization, so this field
   * must be validated as a bare path component (no separators, no ".."
   * segments) — assertPathAllowed's "resolve under an allowed root" model
   * doesn't apply since the value is never a full path here.
   */
  isPathComponent?: boolean;
  /** Positional argument (no flag prefix), appended in declared order. */
  positional?: boolean;
  /**
   * For string[]/number[] fields whose CLI flag takes ONE joined value rather
   * than a repeated flag (e.g. `--images a.png,b.png`, not `--images a.png
   * --images b.png`). Set to the join separator (e.g. ",").
   */
  joinWith?: string;
}

export interface CommandSpec {
  /** CLI subcommand name, e.g. "scene". */
  name: string;
  /** True if the command produces an image output parseable from .manifest.json. */
  writesImage: boolean;
  /** One-line "when to use" for the dispatcher description. */
  when: string;
  fields: Record<string, FieldSpec>;
  /** Whether the command accepts the global --models-root flag (generation cmds do; gate/segment/models/verify do not). */
  acceptsGlobals?: boolean;
  /** Fixed sub-subcommand to insert after `name` (e.g. models → "list"). */
  cliSubcommand?: string;
}

// ─── Field schemas → typebox ─────────────────────────────────────────────────

function fieldSchema(f: FieldSpec): TSchema {
  const wrap = (t: TSchema): TSchema => Type.Optional(t);
  switch (f.type) {
    case "string":
      return wrap(Type.String({ description: f.description }));
    case "number":
      return wrap(Type.Number({ description: f.description }));
    case "int":
      return wrap(Type.Integer({ description: f.description }));
    case "boolean":
      return wrap(Type.Boolean({ description: f.description }));
    case "string[]":
      return wrap(Type.Array(Type.String(), { description: f.description }));
    case "number[]":
      return wrap(Type.Array(Type.Number(), { description: f.description }));
  }
}

/** Build a typebox Type.Object for a command's parameters. */
export function buildParams(spec: CommandSpec) {
  const props: Record<string, TSchema> = {};
  for (const [key, f] of Object.entries(spec.fields)) props[key] = fieldSchema(f);
  return Type.Object(props);
}

// ─── Reusable field blocks ───────────────────────────────────────────────────

/** Shared generation fields present on most image-producing commands. */
const GEN_FIELDS = {
  transformer: { flag: "--transformer", type: "string", isPathComponent: true, description: "Transformer variant under models/transformer/. Omit for the default (klein-9b)." },
  seed: { flag: "--seed", type: "int", description: "Random seed (uint64). Default 42." },
  width: { flag: "--width", type: "int", description: "Output image width (px)." },
  height: { flag: "--height", type: "int", description: "Output image height (px)." },
  steps: { flag: "--steps", type: "int", description: "Number of denoising steps." },
  cfgScale: { flag: "--cfg-scale", type: "number", description: "Classifier-free guidance scale (1.0 = off, recommended for distilled Klein)." },
  output: { flag: "--output", type: "string", isPath: true, description: "Output PNG path. Empty/omit = auto timestamped name in the output dir." },
  outputDir: { flag: "--output-dir", type: "string", isPath: true, description: "Output directory (default: $MLX_OUTPUT_DIR or ../video_generation__output)." },
  name: { flag: "--name", type: "string", description: "Custom base name (default: output_YYYYMMDD_HHMMSS)." },
  vae: { flag: "--vae", type: "string", isPathComponent: true, description: "VAE directory under models/vae/ (default flux2-klein)." },
  encoder: { flag: "--encoder", type: "string", isPathComponent: true, description: "Text-encoder directory under models/text_encoder/ (default qwen3-8b)." },
  tokenizerDir: { flag: "--tokenizer-dir", type: "string", isPathComponent: true, description: "Tokenizer directory under models/tokenizer/ (default qwen3-klein)." },
  noArtifacts: { flag: "--no-artifacts", type: "boolean", description: "Skip writing .run.json + .manifest.json sidecars (not recommended — the tool parses the manifest)." },
  strictGate: { flag: "--strict-gate", type: "boolean", description: "Abort (exit 1) if the output FAILs the image gate. Off by default; the gate verdict is surfaced regardless." },
} satisfies Record<string, FieldSpec>;

/** Generation fields WITHOUT width/height/steps/cfgScale (commands that don't take them, e.g. upscale). */
const GEN_FIELDS_BARE = (() => {
  const { width: _w, height: _h, steps: _s, cfgScale: _c, ...rest } = GEN_FIELDS;
  void _w; void _h; void _s; void _c;
  return rest;
})();

/** GEN_FIELDS minus strictGate — t2i/edit/style/angle's Swift commands don't declare --strict-gate (only scene/upscale do). */
const GEN_FIELDS_NO_STRICT_GATE = (() => {
  const { strictGate: _sg, ...rest } = GEN_FIELDS;
  void _sg;
  return rest;
})();

/** GEN_FIELDS minus fields SwapCommand.swift doesn't declare (verified via `flux2 swap --help`). */
const GEN_FIELDS_SWAP = (() => {
  const { cfgScale: _c, vae: _v, encoder: _e, tokenizerDir: _td, strictGate: _sg, ...rest } = GEN_FIELDS;
  void _c; void _v; void _e; void _td; void _sg;
  return rest;
})();

/** GEN_FIELDS_BARE minus fields UpscaleCommand.swift doesn't declare (pure ESRGAN pass, no MLX transformer/VAE/text-encoder path — verified via `flux2 upscale --help`). */
const GEN_FIELDS_UPSCALE = (() => {
  const { transformer: _t, seed: _s, vae: _v, encoder: _e, tokenizerDir: _td, ...rest } = GEN_FIELDS_BARE;
  void _t; void _s; void _v; void _e; void _td;
  return rest;
})();

// ─── The 18 flux2 subcommands ────────────────────────────────────────────────

export const COMMANDS: Record<string, CommandSpec> = {
  t2i: {
    name: "t2i",
    writesImage: true,
    acceptsGlobals: true,
    when: "Text → single image (Flux2 Klein native). The basic generation path.",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "Text prompt. zh-TW supported (qwen3-8b is multilingual)." },
      negativePrompt: { flag: "--negative-prompt", type: "string", description: "Negative prompt (used only when cfg > 1.0)." },
      ...GEN_FIELDS_NO_STRICT_GATE,
    },
  },

  scene: {
    name: "scene",
    writesImage: true,
    acceptsGlobals: true,
    when: "Compose MULTIPLE reference characters/subjects into one scene (multi-ref Flux2KleinEdit). The flagship command.",
    fields: {
      ref: { flag: "--ref", type: "string[]", isPathArray: true, description: "Reference images — one per distinct subject/character (repeatable)." },
      prompt: { flag: "--prompt", type: "string", description: 'Composition prompt describing the scene. e.g. "兩個角色坐在教室裡考試".' },
      refCountPerImage: { flag: "--ref-count-per-image", type: "int", description: "Latent repeats per reference (1 = one each; raise to weight an identity). Default 1." },
      refStrength: { flag: "--ref-strength", type: "number[]", description: "Per-reference strength, one per --ref (default 1.0). Weight one identity over another." },
      refGateSteps: { flag: "--ref-gate-steps", type: "number", description: "Inject refs only in the first fraction of steps (0.5 = first half). Default 1.0." },
      regional: { flag: "--regional", type: "boolean", description: "Regional placement: refine each ref into a vertical strip (left→right) via masked inpaint. Fixes left/right assignment." },
      regionAttention: { flag: "--region-attention", type: "boolean", description: "EXPERIMENTAL: block-masked region attention during denoise. Mostly inert on distilled Klein (see memory [[flux2-region-attention-no-binding-distilled]])." },
      refMask: { flag: "--ref-mask", type: "string[]", isPathArray: true, description: "Per-ref region mask, one per --ref (white = that ref's region). Default = vertical strips." },
      refRegionMask: { flag: "--ref-region-mask", type: "string[]", isPathArray: true, description: "Region-binding mask, one per --ref (white = preserve, black = attenuate). INERT on distilled Klein ([[flux2-region-attention-no-binding-distilled]])." },
      refRegionStrength: { flag: "--ref-region-strength", type: "number", description: "Attenuation strength in BLACK mask regions (1.0 = full bind, 0.5 = keep 50%). Default 1.0." },
      refRegionFeather: { flag: "--ref-region-feather", type: "int", description: "Feather (latent-px) for region-binding mask edges. Default 2." },
      regionalFeather: { flag: "--regional-feather", type: "int", description: "Seam feather (px) for regional strip inpaint. Default 24." },
      regionalStrength: { flag: "--regional-strength", type: "number", description: "Regional refine strength (SDEdit). 0.45 = light nudge preserving hands; 1.0 = full regen. Default 0.45." },
      handRepair: { flag: "--hand-repair", type: "boolean", description: "Repair hands: SAM3-segment 'hands' then re-denoise that region (best-effort fix for fused fingers)." },
      handRepairStrength: { flag: "--hand-repair-strength", type: "number", description: "Hand-repair denoise strength (0.6 conservative, 0.8 stronger). Default 0.8." },
      bg: { flag: "--bg", type: "string", isPath: true, description: "Background image used as the denoise canvas (inherits its layout/POV). Optional." },
      bgStrength: { flag: "--bg-strength", type: "number", description: "Denoise strength for the --bg canvas (0.3 light, 0.5 restyle, 0.7 loose redraw). Default 0.55." },
      lora: { flag: "--lora", type: "string[]", isPathComponent: true, description: "LoRA name(s) under models/lora/ (stackable)." },
      loraScale: { flag: "--lora-scale", type: "number[]", description: "Per-LoRA scale, one per --lora (trailing default 1.0)." },
      ...GEN_FIELDS,
    },
  },

  edit: {
    name: "edit",
    writesImage: true,
    acceptsGlobals: true,
    when: "Generic reference-conditioned edit/generation (Flux2KleinEdit, multi-ref).",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "Text prompt describing the edit." },
      images: { flag: "--images", type: "string[]", isPathArray: true, joinWith: ",", description: "Reference image path(s) — one per array element (multi-ref)." },
      ...GEN_FIELDS_NO_STRICT_GATE,
    },
  },

  kontext: {
    name: "kontext",
    writesImage: true,
    acceptsGlobals: true,
    when: "In-context generation via FLUX.1-Kontext-dev — identity-anchored single hero image + prompt (e.g. \"same person, different outfit/pose/setting\").",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Hero / identity-anchor image path." },
      prompt: { flag: "--prompt", type: "string", description: "In-context instruction prompt." },
      transformer: { flag: "--transformer", type: "string", isPathComponent: true, description: "Transformer directory under models/transformer/. Default kontext-dev." },
      clipEncoder: { flag: "--clip-encoder", type: "string", isPathComponent: true, description: "CLIP text-encoder directory under models/text_encoder/. Default kontext-dev-clip." },
      t5Encoder: { flag: "--t5-encoder", type: "string", isPathComponent: true, description: "T5 text-encoder directory under models/text_encoder/. Default kontext-dev-t5." },
      vae: { flag: "--vae", type: "string", isPathComponent: true, description: "VAE directory under models/vae/. Default flux-kontext-ae." },
      clipTokenizerDir: { flag: "--clip-tokenizer-dir", type: "string", isPathComponent: true, description: "CLIP tokenizer directory under models/tokenizer/. Default kontext-dev-clip-tok." },
      t5TokenizerDir: { flag: "--t5-tokenizer-dir", type: "string", isPathComponent: true, description: "T5 tokenizer directory under models/tokenizer/. Default kontext-dev-t5-tok." },
      seed: { flag: "--seed", type: "int", description: "Random seed (uint64). Default 42." },
      width: { flag: "--width", type: "int", description: "Output image width (px). Default 1024." },
      height: { flag: "--height", type: "int", description: "Output image height (px). Default 1024." },
      steps: { flag: "--steps", type: "int", description: "Number of denoising steps. Default 20." },
      guidance: { flag: "--guidance", type: "number", description: "CFG-distilled guidance embedding value. Default 2.5." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output PNG path. Empty/omit = auto timestamped name in the output dir." },
      outputDir: { flag: "--output-dir", type: "string", isPath: true, description: "Output directory (default: $MLX_OUTPUT_DIR or ../video_generation__output)." },
      name: { flag: "--name", type: "string", description: "Custom base name (default: output_YYYYMMDD_HHMMSS)." },
      noArtifacts: { flag: "--no-artifacts", type: "boolean", description: "Skip writing .run.json + .manifest.json sidecars (not recommended — the tool parses the manifest)." },
    },
  },

  style: {
    name: "style",
    writesImage: true,
    acceptsGlobals: true,
    when: "Identity-preserving style transfer (anime↔real / photorealistic / 3d-render) via Flux2KleinEdit.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Input character image." },
      preset: { flag: "--preset", type: "string", description: "Style preset: anime2real | real2anime | photorealistic | 3d-render." },
      prompt: { flag: "--prompt", type: "string", description: "Override the style prompt (overrides preset)." },
      refCount: { flag: "--ref-count", type: "int", description: "Reference count (1-3; 3 = best identity fidelity)." },
      lora: { flag: "--lora", type: "string[]", isPathComponent: true, description: "LoRA name(s) under models/lora/ (stackable)." },
      loraScale: { flag: "--lora-scale", type: "number[]", description: "Per-LoRA scale, one per --lora." },
      ...GEN_FIELDS_NO_STRICT_GATE,
    },
  },

  "kv-style-transfer": {
    name: "kv-style-transfer",
    writesImage: true,
    acceptsGlobals: true,
    when: "Training-free K/V-injection style transfer (krea2 mechanism port — V-AdaIN + per-frequency K-scale + Q/K-AdaIN). strength=0 is byte-identical to vanilla t2i at the same seed.",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "Text prompt (content + composition)." },
      styleImage: { flag: "--style-image", type: "string", isPath: true, description: "Style reference image path (PNG/JPG)." },
      strength: { flag: "--strength", type: "number", description: "Style strength 0..1 (0 = byte-identical to vanilla t2i at --seed)." },
      valueAdainStrength: { flag: "--value-adain-strength", type: "number", description: "V-AdaIN strength 0..1 (default 0.65)." },
      adainStrength: { flag: "--adain-strength", type: "number", description: "Q/K cross-batch AdaIN strength 0..1 (upstream recommended 0.85)." },
      refKStrength: { flag: "--ref-k-strength", type: "number", description: "Extra reference-K multiplier (per-frequency scale on top of scaleVec; default 1.06)." },
      lowScaleEnd: { flag: "--low-scale-end", type: "number", description: "High-frequency K-scale ceiling (default 1.10)." },
      activeBlocksStart: { flag: "--active-blocks-start", type: "int", description: "First single DiT block to inject style into (default 7)." },
      activeBlocksEnd: { flag: "--active-blocks-end", type: "int", description: "Last single DiT block to inject style into (default 27)." },
      ...GEN_FIELDS_NO_STRICT_GATE,
    },
  },

  angle: {
    name: "angle",
    writesImage: true,
    acceptsGlobals: true,
    when: "Multi-angle consistent character view from one identity image (Flux2KleinEdit multi-ref).",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Input character image (identity reference)." },
      angle: { flag: "--angle", type: "string", description: "Camera-angle preset: front / front-right / right / rear-right / back / rear-left / left / front-left, front-high / right-high / back-high / front-low / right-low, birds-eye / worms-eye." },
      azimuth: { flag: "--azimuth", type: "number", description: "Azimuth degrees (overrides preset). 0=front, 90=right, 180=back." },
      elevation: { flag: "--elevation", type: "number", description: "Elevation degrees (overrides preset). >0 high-angle, <0 low-angle." },
      prompt: { flag: "--prompt", type: "string", description: "Optional identity/description prompt (default: identity-preservation template)." },
      refCount: { flag: "--ref-count", type: "int", description: "Reference count (1-3; 3 = best identity fidelity)." },
      ...GEN_FIELDS_NO_STRICT_GATE,
    },
  },

  swap: {
    name: "swap",
    writesImage: true,
    acceptsGlobals: true,
    when: "Replace an object in the source image with a reference image (SAM3 mask + composite / inpaint).",
    fields: {
      source: { flag: "--source", type: "string", isPath: true, description: "Source image (the object here is replaced)." },
      reference: { flag: "--reference", type: "string", isPath: true, description: "Reference image (pasted into the mask region)." },
      prompt: { flag: "--prompt", type: "string", description: "Text prompt describing the object to REPLACE in the source (SAM3 text target)." },
      threshold: { flag: "--threshold", type: "number", description: "Detection score threshold. Default 0.2." },
      feather: { flag: "--feather", type: "number", description: "Feather radius for the composite edge (px). Default 20." },
      maskDilate: { flag: "--mask-dilate", type: "int", description: "Dilate the source mask by N px before compositing. Default 0." },
      preserveAspectRatio: { flag: "--preserve-aspect-ratio", type: "boolean", description: "Preserve the reference's aspect ratio when fitting into the mask (no stretch)." },
      inpaint: { flag: "--inpaint", type: "boolean", description: "Seamless mode: regenerate the masked region via Flux2KleinEdit (no paste seam). Uses --reference for identity; overrides feathered paste." },
      harmonize: { flag: "--harmonize", type: "boolean", description: "After compositing, harmonize via Flux2KleinEdit (uses source as reference)." },
      ...GEN_FIELDS_SWAP,
    },
  },

  faceswap: {
    name: "faceswap",
    writesImage: true,
    acceptsGlobals: true,
    when: "BFS face/head swap: combine one image's body/pose with another image's face (Flux2 Klein 9B + BFS LoRA-at-init).",
    fields: {
      body: { flag: "--body", type: "string", isPath: true, description: "Target body image (Image 1) — provides pose/hair/lighting." },
      face: { flag: "--face", type: "string", isPath: true, description: "Source face image (Image 2) — the face to swap in." },
      mode: { flag: "--mode", type: "string", description: "Swap mode: 'face' (keep Image 1's hairstyle, default) or 'head' (swap full head incl. hair)." },
      prompt: { flag: "--prompt", type: "string", description: "Override the swap prompt (default: the mode's BFS template)." },
      lora: { flag: "--lora", type: "string", isPathComponent: true, description: "BFS LoRA name under models/lora/ (default: bfs-head-v1-klein-9b)." },
      loraScale: { flag: "--lora-scale", type: "number", description: "LoRA application strength (default 1.0, the scale BFS was trained at)." },
      ...GEN_FIELDS_NO_STRICT_GATE,
    },
  },

  expand: {
    name: "expand",
    writesImage: true,
    acceptsGlobals: true,
    when: "Outpaint / image expansion — extend borders beyond the canvas (Flux2 latent-mask re-injection).",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Input image to expand." },
      prompt: { flag: "--prompt", type: "string", description: "Prompt describing content to fill the new margins (zh-TW supported)." },
      expand: { flag: "--expand", type: "string", description: "Expansion preset: 'all', a comma list (left,right,top,bottom), or an aspect ratio (16:9, 4:3, 3:2). Default 'all'." },
      pixels: { flag: "--pixels", type: "int", description: "Margin pixels per side (ignored for aspect-ratio presets). Default 128." },
      feather: { flag: "--feather", type: "int", description: "Feather radius (px) across the keep/generate seam. Default 16." },
      transformer: GEN_FIELDS.transformer,
      seed: GEN_FIELDS.seed,
      steps: GEN_FIELDS.steps,
      cfgScale: GEN_FIELDS.cfgScale,
      output: GEN_FIELDS.output,
      outputDir: GEN_FIELDS.outputDir,
      name: GEN_FIELDS.name,
      vae: GEN_FIELDS.vae,
      encoder: GEN_FIELDS.encoder,
      tokenizerDir: GEN_FIELDS.tokenizerDir,
      noArtifacts: GEN_FIELDS.noArtifacts,
      strictGate: GEN_FIELDS.strictGate,
    },
  },

  inpaint: {
    name: "inpaint",
    writesImage: true,
    acceptsGlobals: true,
    when: "Masked redraw / object removal from an arbitrary external mask image (white = regenerate, black = keep bit-for-bit).",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Source image to inpaint." },
      mask: { flag: "--mask", type: "string", isPath: true, description: "Mask image path. White (255) = regenerate, black (0) = keep bit-for-bit." },
      prompt: { flag: "--prompt", type: "string", description: "Prompt describing the content that should fill the masked region." },
      reference: { flag: "--reference", type: "string", isPath: true, description: "Optional reference image for identity/content guidance of the redrawn region." },
      feather: { flag: "--feather", type: "int", description: "Feather radius (px) across the keep/regenerate seam. Default 16." },
      longest: { flag: "--longest", type: "int", description: "Scale the input's longest side to this before inpainting (default 1024)." },
      denoiseStrength: { flag: "--denoise-strength", type: "number", description: "SDEdit-style partial denoise strength on the masked region (default 1.0 = full regen; lower refines from existing content)." },
      transformer: GEN_FIELDS.transformer,
      seed: GEN_FIELDS.seed,
      steps: GEN_FIELDS.steps,
      cfgScale: GEN_FIELDS.cfgScale,
      output: GEN_FIELDS.output,
      outputDir: GEN_FIELDS.outputDir,
      name: GEN_FIELDS.name,
      vae: GEN_FIELDS.vae,
      encoder: GEN_FIELDS.encoder,
      tokenizerDir: GEN_FIELDS.tokenizerDir,
      noArtifacts: GEN_FIELDS.noArtifacts,
      strictGate: GEN_FIELDS.strictGate,
    },
  },

  styletransfer: {
    name: "styletransfer",
    writesImage: true,
    acceptsGlobals: true,
    when: "Restyle a content image to a target visual language via Flux2 Klein SDEdit img2img (preset/prompt-driven, structure preserved).",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Content image path (structure preserved)." },
      stylePreset: { flag: "--style-preset", type: "string", description: "Named style preset: clean-professional | watercolor | oil-painting | anime | cinematic | 3d-render | line-art | low-poly." },
      prompt: { flag: "--prompt", type: "string", description: "Free-form style description (amplifies or overrides the preset)." },
      strength: { flag: "--strength", type: "number", description: "Style strength = img2img denoise (0-1]. Default 0.55." },
      lora: { flag: "--lora", type: "string[]", isPathComponent: true, description: "LoRA name(s) under models/lora/ (stackable)." },
      loraScale: { flag: "--lora-scale", type: "number[]", description: "Per-LoRA scale, one per --lora." },
      ...GEN_FIELDS,
    },
  },

  "face-detail": {
    name: "face-detail",
    writesImage: true,
    acceptsGlobals: true,
    when: "Detect faces (Apple Vision) and regenerate each at higher detail via low-denoise SDEdit, feathered-composited back — port of face_detailer.py. Copies input to output unchanged if no faces are detected.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Source image path." },
      prompt: { flag: "--prompt", type: "string", description: "Text prompt describing the person/scene, used for face-detail regeneration." },
      padding: { flag: "--padding", type: "number", description: "Bounding-box expansion factor around each detected face. Default 1.8." },
      feather: { flag: "--feather", type: "int", description: "Feather radius (px) for the composite seam. Default 20." },
      denoiseStrength: { flag: "--denoise-strength", type: "number", description: "SDEdit denoise strength on each face crop (0.15 subtle .. 0.3 noticeable). Default 0.15." },
      steps: { flag: "--steps", type: "int", description: "Denoising steps for face regeneration. Default 9." },
      minConfidence: { flag: "--min-confidence", type: "number", description: "Minimum Vision face-detection confidence (0-1). Default 0.5." },
      seed: GEN_FIELDS.seed,
      transformer: GEN_FIELDS.transformer,
      vae: GEN_FIELDS.vae,
      encoder: GEN_FIELDS.encoder,
      tokenizerDir: GEN_FIELDS.tokenizerDir,
      output: GEN_FIELDS.output,
      outputDir: GEN_FIELDS.outputDir,
      name: GEN_FIELDS.name,
      noArtifacts: GEN_FIELDS.noArtifacts,
      strictGate: GEN_FIELDS.strictGate,
    },
  },

  "postprocess": {
    name: "postprocess",
    writesImage: true,
    acceptsGlobals: false,
    when: "Pixel-filter post-processing (film grain, CAS+unsharp sharpening, bilateral noise-clean, CLAHE skin-contrast) on an existing image — port of postprocess.py's PostProcessChain. No model load.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Source image path." },
      filmGrain: { flag: "--film-grain", type: "number", description: "Film grain intensity (0 = off). Default 0." },
      sharpening: { flag: "--sharpening", type: "number", description: "CAS sharpening strength (0 = off). Default 0." },
      skinContrast: { flag: "--skin-contrast", type: "boolean", description: "Apply CLAHE contrast enhancement to detected skin-tone regions." },
      noiseClean: { flag: "--noise-clean", type: "boolean", description: "Apply bilateral denoise + JPEG-artifact scrub." },
      seed: GEN_FIELDS.seed,
      output: GEN_FIELDS.output,
    },
  },

  upscale: {
    name: "upscale",
    writesImage: true,
    acceptsGlobals: true,
    when: "4× super-resolution (RealPLKSR / ESRGAN, native Swift MLX).",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Input image to upscale." },
      model: { flag: "--model", type: "string", isPathComponent: true, description: "ESRGAN model name under models/upscale/ (default 4x-nomos-webphoto-realplksr)." },
      tileSize: { flag: "--tile-size", type: "int", description: "LR tile size for tiled inference (auto-enables when input > tile). Default 256." },
      tileOverlap: { flag: "--tile-overlap", type: "int", description: "Tile overlap (LR px) feather-blended between tiles. Default 32." },
      noTile: { flag: "--no-tile", type: "boolean", description: "Force whole-image inference (no tiling). May OOM on 4K+ sources." },
      ...GEN_FIELDS_UPSCALE,
      strictGate: GEN_FIELDS.strictGate,
    },
  },

  gate: {
    name: "gate",
    writesImage: false,
    when: "Score existing image file(s) with the ImageGate (noise / blank / NaN detector). NO generation. Use --json for parseable output.",
    fields: {
      images: { flag: "", positional: true, type: "string[]", isPathArray: true, description: "Image file(s) to gate (positional)." },
      json: { flag: "--json", type: "boolean", description: "Emit machine-readable JSON (one array). Recommended for the agent." },
      strict: { flag: "--strict", type: "boolean", description: "Treat WARN as failure too (exit 1)." },
    },
  },

  segment: {
    name: "segment",
    writesImage: true,
    when: "Text-prompted SAM3.1 segmentation → mask PNG (white = object). Uses a Python mlx-vlm bridge.",
    fields: {
      image: { flag: "--image", type: "string", isPath: true, description: "Input image to segment." },
      prompt: { flag: "--prompt", type: "string", description: 'Text prompt describing the object to segment (e.g. "woman\'s face").' },
      threshold: { flag: "--threshold", type: "number", description: "Detection score threshold (0-1). Default 0.3." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output mask PNG path (white = object, feathered edges)." },
    },
  },

  cutout: {
    name: "cutout",
    writesImage: true,
    when: "Transparent-background cutout: SAM3 text segmentation → alpha-composited RGBA PNG. No regeneration — subject pixels preserved verbatim.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Source image path." },
      subject: { flag: "--subject", type: "string", description: "SAM3 text prompt for the subject to cut out (e.g. 'woman', 'coffee cup'). Falls back to --prompt if omitted." },
      prompt: { flag: "--prompt", type: "string", description: "Fallback subject text if --subject is omitted." },
      samThreshold: { flag: "--sam-threshold", type: "number", description: "SAM3 detection score threshold (0-1). Default 0.3." },
      trim: { flag: "--trim", type: "boolean", description: "Crop the result to the alpha bounding box + 5% margin." },
      saveMask: { flag: "--save-mask", type: "boolean", description: "Also save the SAM3 mask + a green-tint overlay alongside the cutout, for inspection." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output RGBA PNG path." },
    },
  },

  story: {
    name: "story",
    writesImage: true,
    acceptsGlobals: true,
    when: "Character-story director: one consistent character across multiple angle:prompt scenes.",
    fields: {
      character: { flag: "--character", type: "string", description: 'Character description (e.g. "a young woman with red hair in armor").' },
      scenes: { flag: "--scenes", type: "string", description: 'Comma-separated scene specs, each "angle:prompt" (e.g. "right:walking through forest,front-high:standing on a cliff"). Default: 4 classic angles.' },
      refCount: { flag: "--ref-count", type: "int", description: "Reference count per scene (1-3). Default 3." },
      transformer: GEN_FIELDS.transformer,
      seed: GEN_FIELDS.seed,
      width: GEN_FIELDS.width,
      height: GEN_FIELDS.height,
      steps: GEN_FIELDS.steps,
      outputDir: GEN_FIELDS.outputDir,
      name: GEN_FIELDS.name,
      vae: GEN_FIELDS.vae,
      encoder: GEN_FIELDS.encoder,
      tokenizerDir: GEN_FIELDS.tokenizerDir,
      noArtifacts: GEN_FIELDS.noArtifacts,
    },
  },

  models: {
    name: "models",
    writesImage: false,
    cliSubcommand: "list",
    when: "List installed Flux2 Klein model variants. NO generation. Read-only.",
    fields: {},
  },

  // ── verify-* : numerical comparison vs Python mflux reference (dev/diagnostic) ──
  "verify-vae": {
    name: "verify-vae",
    writesImage: false,
    when: "Diagnostic: compare Swift Flux2 VAE (encode/decode/packed) vs Python mflux reference.",
    fields: {
      vae: { flag: "--vae", type: "string", isPathComponent: true, description: "VAE variant directory (under models/vae/)." },
      reference: { flag: "--ref", type: "string", isPath: true, description: "Reference safetensors from gen_flux2_vae_ref.py." },
      threshold: { flag: "--threshold", type: "number", description: "Cosine similarity pass threshold. Default 0.99." },
    },
  },
  "verify-encoder": {
    name: "verify-encoder",
    writesImage: false,
    when: "Diagnostic: compare Swift Flux2 text encoder vs Python mflux reference.",
    fields: {
      encoder: { flag: "--encoder", type: "string", isPathComponent: true, description: "Text-encoder directory (under models/text_encoder/)." },
      reference: { flag: "--ref", type: "string", isPath: true, description: "Reference safetensors from gen_flux2_encoder_ref.py." },
      threshold: { flag: "--threshold", type: "number", description: "Cosine similarity pass threshold. Default 0.99." },
    },
  },
  "verify-tokenizer": {
    name: "verify-tokenizer",
    writesImage: false,
    when: "Diagnostic: compare Swift Flux2 tokenizer output vs Python reference.",
    fields: {
      tokenizerDir: { flag: "--tokenizer", type: "string", isPathComponent: true, description: "Tokenizer directory (under models/tokenizer/)." },
      reference: { flag: "--ref", type: "string", isPath: true, description: "Reference safetensors from gen_flux2_encoder_ref.py." },
    },
  },
  "verify-transformer": {
    name: "verify-transformer",
    writesImage: false,
    when: "Diagnostic: compare Swift Flux2 transformer (1 step) vs Python mflux reference.",
    fields: {
      transformer: { flag: "--transformer", type: "string", isPathComponent: true, description: "Transformer directory (under models/transformer/)." },
      reference: { flag: "--ref", type: "string", isPath: true, description: "Reference safetensors from gen_flux2_transformer_ref.py." },
      threshold: { flag: "--threshold", type: "number", description: "Cosine similarity pass threshold. Default 0.99." },
    },
  },
  "verify-e2e": {
    name: "verify-e2e",
    writesImage: false,
    when: "Diagnostic: compare Swift Flux2 full denoise loop (final latent) vs Python mflux.",
    fields: {
      transformer: { flag: "--transformer", type: "string", isPathComponent: true, description: "Transformer (default klein-9b)." },
      encoder: { flag: "--encoder", type: "string", isPathComponent: true, description: "Text encoder (default qwen3-8b)." },
      tokenizerDir: { flag: "--tokenizer-dir", type: "string", isPathComponent: true, description: "Tokenizer (default qwen3-klein)." },
      reference: { flag: "--ref", type: "string", isPath: true, description: "Reference from gen_flux2_e2e_ref.py." },
      threshold: { flag: "--threshold", type: "number", description: "Cosine similarity pass threshold. Default 0.98." },
    },
  },
  "verify-edit": {
    name: "verify-edit",
    writesImage: false,
    when: "Diagnostic: compare Swift Flux2 reference conditioning vs Python mflux.",
    fields: {
      vae: { flag: "--vae", type: "string", isPathComponent: true, description: "VAE (default flux2-klein)." },
      reference: { flag: "--ref", type: "string", isPath: true, description: "Reference from gen_flux2_edit_ref.py." },
      referenceImage: { flag: "--image", type: "string", isPath: true, description: "Reference image (saved by the Python generator)." },
      threshold: { flag: "--threshold", type: "number", description: "Cosine similarity pass threshold. Default 0.99." },
    },
  },
};

// ─── Args builder ────────────────────────────────────────────────────────────

function fmtScalar(f: FieldSpec, v: number | string): string {
  return f.type === "number" || f.type === "int" ? String(v) : String(v);
}

/**
 * Translate a typed options object into a flux2 CLI token list, in the order
 * fields are declared. Only emits flags for keys that are present (!== undefined).
 * Path validation is the caller's responsibility (see pathFieldKeys).
 */
export function buildArgs(spec: CommandSpec, options: Record<string, unknown>): string[] {
  const args: string[] = [];
  const positionalBuf: string[] = [];
  for (const [key, f] of Object.entries(spec.fields)) {
    if (!(key in options)) continue;
    const v = options[key];
    if (v === undefined || v === null) continue;

    if (f.type === "boolean") {
      if (v === true) {
        if (f.positional) throw new Error(`boolean positional field "${key}" is invalid`);
        args.push(f.flag);
      }
      continue;
    }

    if (f.positional) {
      if (Array.isArray(v)) {
        for (const item of v) positionalBuf.push(String(item));
      } else {
        positionalBuf.push(String(v));
      }
      continue;
    }

    if (f.type === "string[]" || f.type === "number[]") {
      if (!Array.isArray(v)) {
        throw new Error(`field "${key}" expects an array, got ${typeof v}`);
      }
      if (f.joinWith != null) {
        args.push(f.flag, v.map((item) => fmtScalar(f, item)).join(f.joinWith));
      } else {
        for (const item of v) args.push(f.flag, fmtScalar(f, item));
      }
      continue;
    }

    // scalar string / number / int
    args.push(f.flag, fmtScalar(f, v as number | string));
  }
  // Positionals go last (gate <images>).
  return [...args, ...positionalBuf];
}

/** Keys of path-typed fields (for pre-flight path validation). */
export function pathFieldKeys(spec: CommandSpec): string[] {
  return Object.entries(spec.fields)
    .filter(([, f]) => f.isPath || f.isPathArray)
    .map(([k]) => k);
}

/** All flag names this command models (for the check-flags drift guard). */
export function modeledFlags(spec: CommandSpec): string[] {
  return Object.values(spec.fields)
    .filter((f) => !f.positional && f.flag)
    .map((f) => f.flag);
}

/** Command display list for the tool description. */
export const COMMAND_LIST = Object.values(COMMANDS);
