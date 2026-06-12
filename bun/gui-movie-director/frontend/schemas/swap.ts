import type { CommandSchema } from "./types";

export const SWAP_SCHEMA: CommandSchema = {
  action: "swap",
  submitLabel: "Swap Region",
  runningLabel: "Swapping...",
  isDisabled: (s) => !s.input_image || !s.reference || !s.sam_prompt?.trim(),
  sections: [
    {
      title: "Images",
      fields: [
        { type: "image", key: "input_image", label: "Source Image", required: true },
        { type: "image", key: "reference", label: "Reference Image", required: true },
      ],
    },
    {
      title: "SAM Segmentation",
      fields: [
        { type: "text", key: "sam_prompt", label: "SAM Prompt (what to swap in source) *", placeholder: "e.g. shirt, car, background" },
        { type: "text", key: "ref_sam_prompt", label: "Reference SAM Prompt (what to extract from reference)", placeholder: "Defaults to same as SAM Prompt" },
      ],
    },
    {
      title: "Settings",
      fields: [
        { type: "range", key: "sam_threshold", label: "SAM Threshold", min: 0, max: 1, step: 0.05, default: 0.3 },
        { type: "number", key: "feather", label: "Feather", min: 0, max: 100, default: 10 },
        { type: "toggle", key: "blend", label: "Blend (smooth composite)" },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    reference: s.reference,
    sam_prompt: s.sam_prompt?.trim(),
    ref_sam_prompt: s.ref_sam_prompt?.trim() || undefined,
    sam_threshold: s.sam_threshold !== 0.3 ? s.sam_threshold : undefined,
    feather: s.feather !== 10 ? s.feather : undefined,
    blend: s.blend || undefined,
  }),
};
