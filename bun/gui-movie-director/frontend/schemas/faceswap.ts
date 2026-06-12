import type { CommandSchema } from "./types";

export const FACESWAP_SCHEMA: CommandSchema = {
  action: "faceswap",
  submitLabel: "Swap Face",
  runningLabel: "Swapping...",
  isDisabled: (s) => !s.body || !s.face,
  sections: [
    {
      title: "Images",
      fields: [
        { type: "image", key: "body", label: "Body Image", required: true },
        { type: "image", key: "face", label: "Face Image", required: true },
      ],
    },
    {
      title: "Settings",
      fields: [
        { type: "select", key: "mode", label: "Mode", options: [
          { value: "head", label: "Head Swap" },
          { value: "face", label: "Face Swap" },
        ], default: "head" },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.body,
    face: s.face,
    mode: s.mode,
    seed: s.seed,
  }),
};
