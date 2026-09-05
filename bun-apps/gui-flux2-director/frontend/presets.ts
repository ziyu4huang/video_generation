/**
 * presets.ts — quality presets + LoRA stacks for the expert UI.
 *
 * The realism stack names/scales mirror what the repo's flux2 workflows ship
 * on disk under mlx-models/lora/ (the CLI only accepts LoRA dirs that exist);
 * the full 12-stack is the README's scene-tuned recipe. The UI filters both
 * against /api/models so missing LoRAs never reach the CLI.
 */

export interface LoraPresetEntry {
  name: string;
  scale: number;
}

export interface LoraStack {
  id: string;
  label: string;
  hint: string;
  entries: LoraPresetEntry[];
}

export const LORA_STACKS: LoraStack[] = [
  {
    id: "realism-detail",
    label: "Realism & Detail",
    hint: "t2i-tuned: detail + quality + skin realism + resolution",
    entries: [
      { name: "details-9b", scale: 0.8 },
      { name: "qualitya", scale: 0.8 },
      { name: "nexblend-asian", scale: 0.8 },
      { name: "highresolutionflux2-kelien-9b", scale: 0.6 },
    ],
  },
  {
    id: "full-12",
    label: "Full 12-stack",
    hint: "the scene-tuned ComfyUI recipe (anything2real family)",
    entries: [
      { name: "anything2real-a", scale: 0.5 },
      { name: "anything2real-characters", scale: 0.8 },
      { name: "chest-9b", scale: 1.0 },
      { name: "skin-tone", scale: 1.0 },
      { name: "lips-9b", scale: 1.0 },
      { name: "eye-9b", scale: 0.5 },
      { name: "details-9b", scale: 0.8 },
      { name: "longface-9b", scale: 0.5 },
      { name: "colorful", scale: 0.5 },
      { name: "qualitya", scale: 0.8 },
      { name: "darkklein-v2bfs-r256", scale: 0.25 },
      { name: "nexblend-asian", scale: 0.8 },
    ],
  },
];

export interface QualityPreset {
  id: string;
  label: string;
  hint: string;
  steps: number;
  autoUpscale: boolean;
  stackId: string | null;
}

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: "draft",
    label: "Draft",
    hint: "4 steps · no LoRA · fastest iteration",
    steps: 4,
    autoUpscale: false,
    stackId: null,
  },
  {
    id: "balanced",
    label: "Balanced",
    hint: "6 steps · no LoRA · good middle ground",
    steps: 6,
    autoUpscale: false,
    stackId: null,
  },
  {
    // 6 measured == 8 visually on the distilled Klein (same-seed A/B,
    // 2026-09-04): the extra 2 steps bought nothing and cost ~25% runtime.
    // Detail is restored by the chained RealPLKSR 4× anyway.
    id: "quality",
    label: "Quality",
    hint: "6 steps (measured ≡ 8 on distilled Klein) · Realism & Detail stack · auto 4×",
    steps: 6,
    autoUpscale: true,
    stackId: "realism-detail",
  },
];

export interface SizePreset {
  label: string;
  width: number;
  height: number;
}

/** All multiples of 16 — the latent grid requires it. */
export const SIZE_PRESETS: SizePreset[] = [
  { label: "1:1 1024", width: 1024, height: 1024 },
  { label: "3:4 896×1152", width: 896, height: 1152 },
  { label: "4:3 1152×864", width: 1152, height: 864 },
  { label: "16:9 1280×720", width: 1280, height: 720 },
  { label: "9:16 720×1280", width: 720, height: 1280 },
];

export function randomSeed(): string {
  return String(Math.floor(Math.random() * 2 ** 48));
}

/** Narrator voices for auto-story mode (Kokoro 82M, local). "" = auto by language. */
export const VOICE_CHOICES: Array<{ id: string; label: string }> = [
  { id: "", label: "Auto (match story language)" },
  { id: "af_heart", label: "af_heart · English female" },
  { id: "am_michael", label: "am_michael · English male" },
  { id: "zf_xiaobei", label: "zf_xiaobei · 中文 female" },
  { id: "zm_yunjian", label: "zm_yunjian · 中文 male" },
];

/** Filter a stack to LoRAs that exist on disk; null when nothing survives. */
export function resolveStack(
  stack: LoraStack,
  available: string[] | undefined,
): LoraPresetEntry[] {
  if (!available) return stack.entries;
  const set = new Set(available);
  return stack.entries.filter((e) => set.has(e.name));
}
