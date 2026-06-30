import { useEffect } from "react";
import { addListener } from "./wsClient";

export function useWebSocketEvents(onMessage: (msg: Record<string, any>) => void): void {
  useEffect(() => {
    return addListener(onMessage);
  }, [onMessage]);
}
