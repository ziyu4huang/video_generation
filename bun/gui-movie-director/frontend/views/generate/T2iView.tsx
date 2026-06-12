import { T2I_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const T2iView = createCommandView(T2I_SCHEMA);

export const t2iDescriptor: ViewDescriptor = {
  id: "t2i", group: "Generate", label: "Text → Image", icon: "🎨",
  component: T2iView,
};
