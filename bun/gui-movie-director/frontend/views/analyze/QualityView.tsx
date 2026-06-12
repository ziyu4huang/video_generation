import { QUALITY_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const QualityView = createCommandView(QUALITY_SCHEMA);

export const qualityDescriptor: ViewDescriptor = {
  id: "quality", group: "Analyze", label: "Quality", icon: "📊",
  component: QualityView,
};
