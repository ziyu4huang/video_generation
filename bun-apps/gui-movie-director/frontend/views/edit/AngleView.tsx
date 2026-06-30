import { ANGLE_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const AngleView = createCommandView(ANGLE_SCHEMA);

export const angleDescriptor: ViewDescriptor = {
  id: "angle", group: "Edit", label: "Camera Angle", icon: "📐",
  component: AngleView,
};
