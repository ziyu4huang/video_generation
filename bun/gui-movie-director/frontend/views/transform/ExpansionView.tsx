import { EXPANSION_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const ExpansionView = createCommandView(EXPANSION_SCHEMA);

export const expansionDescriptor: ViewDescriptor = {
  id: "expansion", group: "Transform", label: "Expansion", icon: "↔️",
  component: ExpansionView,
};
