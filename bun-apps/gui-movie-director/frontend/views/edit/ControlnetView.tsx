import { CONTROLNET_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const ControlnetView = createCommandView(CONTROLNET_SCHEMA);

export const controlnetDescriptor: ViewDescriptor = {
  id: "controlnet", group: "Edit", label: "ControlNet", icon: "🎯",
  component: ControlnetView,
};
