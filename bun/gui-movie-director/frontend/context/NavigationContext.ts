import { createContext, useContext } from "react";

export const NavigationContext = createContext<(view: { type: string; action?: string; highlight?: string[] }) => void>(() => {});
export const useNavigation = () => useContext(NavigationContext);
