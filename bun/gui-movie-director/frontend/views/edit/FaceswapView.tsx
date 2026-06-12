import { FACESWAP_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const FaceswapView = createCommandView(FACESWAP_SCHEMA);

export const faceswapDescriptor: ViewDescriptor = {
  id: "faceswap", group: "Edit", label: "Face Swap", icon: "👤",
  component: FaceswapView,
};
