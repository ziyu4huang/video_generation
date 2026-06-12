import { IMAGE_RESTORE_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const ImageRestoreView = createCommandView(IMAGE_RESTORE_SCHEMA);

export const imageRestoreDescriptor: ViewDescriptor = {
  id: "img-restore", group: "Transform", label: "Image Restore", icon: "✨",
  component: ImageRestoreView,
};
