import type { CommandSchema } from "./types";

export const PROFILE_SCHEMA: CommandSchema = {
  action: "profile",
  submitLabel: "Generate Profile",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  sections: [
    {
      title: "Character",
      fields: [
        { type: "prompt", key: "prompt", required: true, placeholder: "Describe the character in detail..." },
        { type: "text", key: "base_prompt", label: "Base Prompt Override", placeholder: "Override the default photographic base prompt..." },
      ],
    },
    {
      title: "Settings",
      fields: [
        { type: "select", key: "views", label: "Views", options: [
          { value: "front,back,side", label: "All Views" },
          { value: "front", label: "Front Only" },
          { value: "front,back", label: "Front + Back" },
        ], default: "front,back,side" },
        { type: "select", key: "ratio", label: "Pose", options: [
          { value: "standing", label: "Standing" },
          { value: "sitting", label: "Sitting" },
        ], default: "standing" },
        { type: "number", key: "ref_count", label: "Reference Count", min: 1, max: 4, default: 3 },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
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
