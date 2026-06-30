import { I2I_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const I2iView = createCommandView(I2I_SCHEMA);

export const i2iDescriptor: ViewDescriptor = {
  id: "i2i", group: "Transform", label: "Image → Image", icon: "🖼️",
  component: I2iView,
};
