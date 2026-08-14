import type { WebFrame } from "./protocol.js";
import type { BtwEvent, BtwThreadState } from "./btw-channels.js";

const EMPTY_STATE: BtwThreadState = {
  messages: [],
  mode: "contextual",
  model: null,
  thinking: null,
};

/** Latest-snapshot store for GET /api/btw (pull-then-subscribe, D7). */
export interface BtwStore {
  apply(event: BtwEvent): void;
  state(): BtwThreadState;
}

export function createBtwStore(): BtwStore {
  let current: BtwThreadState | null = null;
  return {
    apply(event) {
      if (event.type === "thread") current = event.state;
    },
    state() {
      return current ?? EMPTY_STATE;
    },
  };
}

/** Bus event -> store update + broadcast of the new `btw` WebFrame (D5). */
export function createBtwForwarder(
  store: BtwStore,
  broadcast: (frame: WebFrame) => void,
): (event: BtwEvent) => void {
  return (event) => {
    store.apply(event);
    broadcast({ type: "btw", event });
  };
}
