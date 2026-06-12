import type { ComponentType } from "react";

export interface ViewDescriptor {
  id: string;
  group: string;
  label: string;
  icon: string;
  component: ComponentType;
}

export const GROUP_ORDER = ["Generate", "Workflow", "Transform", "Edit", "Analyze", "Tools"];
