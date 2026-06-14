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

// Common resolutions offered as a quick picker in the T2I form. The value is a
// "WxH" key; RESOLUTION_MAP expands it to [width, height]. Per-pipeline
// preference (which key auto-selects on pipeline switch) comes from the server
// via schema-defaults `pipeline_resolution` ([w, h] per pipeline).
export const RESOLUTION_CHOICES = [
  { value: "512x512", label: "512×512 (fast)" },
  { value: "640x960", label: "640×960 (portrait)" },
  { value: "960x640", label: "960×640 (landscape)" },
  { value: "1024x1024", label: "1024×1024 (square HD)" },
  { value: "1440x1440", label: "1440×1440 (gallery)" },
];

export const RESOLUTION_MAP: Record<string, [number, number]> = {
  "512x512": [512, 512],
  "640x960": [640, 960],
  "960x640": [960, 640],
  "1024x1024": [1024, 1024],
  "1440x1440": [1440, 1440],
};

/** Inverse lookup: [width, height] → "WxH" key, or undefined if not a preset. */
export function resolutionKey(w: number, h: number): string | undefined {
  return Object.entries(RESOLUTION_MAP).find(([, [rw, rh]]) => rw === w && rh === h)?.[0];
}
