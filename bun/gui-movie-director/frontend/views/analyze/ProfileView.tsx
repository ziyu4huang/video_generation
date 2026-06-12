import { PROFILE_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

export const ProfileView = createCommandView(PROFILE_SCHEMA);

export const profileDescriptor: ViewDescriptor = {
  id: "profile", group: "Analyze", label: "Character Profile", icon: "📋",
  component: ProfileView,
};
