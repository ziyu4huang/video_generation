import { ANIME2REAL_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const Anime2realView = createCommandView(ANIME2REAL_SCHEMA);

export const anime2realDescriptor: ViewDescriptor = {
  id: "anime2real", group: "Transform", label: "Anime → Real", icon: "🎭",
  component: Anime2realView,
};
