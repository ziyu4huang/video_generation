import { PURIFY_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

// SeedVR2 AI purification / artifact removal / quality enhance. The form is
// generated from PURIFY_SCHEMA (schemas/purify.ts) — see image-purify.py for
// the backend mode presets (softness) and resolution handling.
export const PurifyView = createCommandView(PURIFY_SCHEMA);

export const purifyDescriptor: ViewDescriptor = {
  id: "purify", group: "Transform", label: "Purify", icon: "🫧",
  component: PurifyView,
};
