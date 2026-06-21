export const PIPELINE_OPTIONS = [
  { value: "zimage", label: "ZImage Turbo" },
  { value: "flux2-klein", label: "Flux2 Klein 9B" },
  { value: "auto", label: "Auto" },
];

// T2I-only pipelines. Adds "lens" (Microsoft Lens 3.8B), a separate model
// family with no LoRA/ControlNet/i2i path — so it is NOT shared with the
// i2i/workflow/controlnet/profile/restore views, which can't route to it.
export const T2I_PIPELINE_OPTIONS = [
  { value: "zimage", label: "ZImage Turbo" },
  { value: "flux2-klein", label: "Flux2 Klein 9B" },
  { value: "lens", label: "Microsoft Lens 3.8B" },
  { value: "auto", label: "Auto" },
];

// Common resolutions offered as a quick picker in the T2I form, grouped by
// aspect ratio (SelectField renders each `group` as an <optgroup>). The value
// is a "WxH" key; RESOLUTION_MAP expands it to [width, height]. Each ratio
// offers an HD and a 2K tier (2K = each side ×2 of the HD base, QHD-class —
// the "two-times HD" high-def option). All dimensions are multiples of 16
// (Flux2/zimage VAE /8 × patchify /2 constraint). Per-pipeline preference
// (which key auto-selects on pipeline switch) comes from the server via
// schema-defaults `pipeline_resolution` ([w, h] per pipeline). `custom` has no
// group so it renders outside the optgroups.
export const RESOLUTION_CHOICES = [
  // Portrait (taller than wide)
  { value: "640x960", label: "640×960 · 2:3 HD", group: "Portrait" },
  { value: "1024x1536", label: "1024×1536 · 2:3 2K", group: "Portrait" },
  { value: "720x1280", label: "720×1280 · 9:16 mobile HD", group: "Portrait" },
  { value: "1440x2560", label: "1440×2560 · 9:16 mobile 2K", group: "Portrait" },
  // Landscape (wider than tall)
  { value: "960x640", label: "960×640 · 3:2 HD", group: "Landscape" },
  { value: "1536x1024", label: "1536×1024 · 3:2 2K", group: "Landscape" },
  { value: "1280x720", label: "1280×720 · 16:9 video HD", group: "Landscape" },
  { value: "2560x1440", label: "2560×1440 · 16:9 video 2K", group: "Landscape" },
  // Square
  { value: "512x512", label: "512×512 · fast", group: "Square" },
  { value: "1024x1024", label: "1024×1024 · HD", group: "Square" },
  { value: "1440x1440", label: "1440×1440 · gallery", group: "Square" },
  { value: "2048x2048", label: "2048×2048 · 2K", group: "Square" },
  // Ungrouped
  { value: "custom", label: "Custom…" },
];

// Maps a UI "pipeline" select value to the LoRA manifest `pipeline` tags it
// accepts (see python/mlx-movie-director/models/lora/*/manifest.json). Used to
// filter the LoraField dropdown so e.g. picking "zimage" doesn't show
// flux2-klein-only LoRAs. `undefined` means "don't filter" (server resolves
// the actual pipeline at runtime, e.g. "auto"); an empty array means the
// pipeline has no LoRA support at all (e.g. Microsoft Lens).
export const PIPELINE_TO_LORA_TAGS: Record<string, string[] | undefined> = {
  zimage: ["zimage-turbo"],
  "flux2-klein": ["flux2-klein", "flux2-klein-edit"],
  lens: [],
  auto: undefined,
};

export const RESOLUTION_MAP: Record<string, [number, number]> = {
  // Square (1:1)
  "512x512": [512, 512],
  "1024x1024": [1024, 1024],
  "1440x1440": [1440, 1440],
  "2048x2048": [2048, 2048],
  // 2:3 portrait / 3:2 landscape
  "640x960": [640, 960],
  "960x640": [960, 640],
  "1024x1536": [1024, 1536],
  "1536x1024": [1536, 1024],
  // 9:16 mobile portrait / 16:9 video landscape
  "720x1280": [720, 1280],
  "1280x720": [1280, 720],
  "1440x2560": [1440, 2560],
  "2560x1440": [2560, 1440],
};

/** Inverse lookup: [width, height] → "WxH" key, or undefined if not a preset. */
export function resolutionKey(w: number, h: number): string | undefined {
  return Object.entries(RESOLUTION_MAP).find(([, [rw, rh]]) => rw === w && rh === h)?.[0];
}
