import { SWAP_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const SwapView = createCommandView(SWAP_SCHEMA);

export const swapDescriptor: ViewDescriptor = {
  id: "swap", group: "Edit", label: "Region Swap", icon: "✂️",
  component: SwapView,
};
