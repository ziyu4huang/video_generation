import { WORKFLOW_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const ImagePipelineView = createCommandView(WORKFLOW_SCHEMA);

export const imagePipelineDescriptor: ViewDescriptor = {
  id: "img-workflow", group: "Workflow", label: "Image Pipeline", icon: "🖼️",
  component: ImagePipelineView,
};
