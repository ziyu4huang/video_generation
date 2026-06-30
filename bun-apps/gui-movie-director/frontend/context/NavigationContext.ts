import { createContext, useContext } from "react";

// navigate(path, highlight?) — e.g. navigate("/gallery", ["file.png"]) or navigate("/cmd/t2i")
export const NavigationContext = createContext<(path: string, highlight?: string[]) => void>(() => {});
export const useNavigation = () => useContext(NavigationContext);
