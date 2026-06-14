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
