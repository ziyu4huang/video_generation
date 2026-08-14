### Task 7: snapshot store + broadcast forwarder

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/btw-store.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/btw-store.test.ts`

**Interfaces:**
- Consumes: Task 5 (`BtwEvent`, `BtwThreadState`); existing `WebFrame` from `./protocol`.
- Produces: `interface BtwStore { apply(event: BtwEvent): void; state(): BtwThreadState }`; `createBtwStore(): BtwStore`; `createBtwForwarder(store: BtwStore, broadcast: (frame: WebFrame) => void): (event: BtwEvent) => void`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/btw-store.test.ts
import { describe, expect, it } from "bun:test";
import type { WebFrame } from "../src/protocol";
import { createBtwForwarder, createBtwStore } from "../src/btw-store";
import type { BtwEvent, BtwThreadState } from "../src/btw-channels";

const STATE: BtwThreadState = {
  messages: [{ id: "btw-m-0", role: "user", text: "q", status: "done" }],
  mode: "contextual",
  model: null,
  thinking: null,
};

describe("createBtwStore", () => {
  it("defaults to an empty contextual thread", () => {
    expect(createBtwStore().state()).toEqual({
      messages: [],
      mode: "contextual",
      model: null,
      thinking: null,
    });
  });

  it("keeps only the latest thread state; notices do not clobber it", () => {
    const store = createBtwStore();
    store.apply({ type: "thread", state: STATE });
    store.apply({ type: "notice", text: "Injected into the main session" });
    expect(store.state()).toEqual(STATE);
  });
});

describe("createBtwForwarder", () => {
  it("applies thread events to the store AND broadcasts a btw frame", () => {
    const store = createBtwStore();
    const frames: WebFrame[] = [];
    const forward = createBtwForwarder(store, (frame) => frames.push(frame));

    const threadEvent: BtwEvent = { type: "thread", state: STATE };
    forward(threadEvent);
    expect(frames).toEqual([{ type: "btw", event: threadEvent }]);
    expect(store.state()).toEqual(STATE);

    const noticeEvent: BtwEvent = { type: "notice", text: "ok" };
    forward(noticeEvent);
    expect(frames).toEqual([{ type: "btw", event: threadEvent }, { type: "btw", event: noticeEvent }]);
    expect(store.state()).toEqual(STATE); // notice did not clobber the snapshot
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-store.test.ts )`
Expected: FAIL — cannot resolve `../src/btw-store`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bun-apps/pi-agent-ext-webui/src/btw-store.ts
import type { WebFrame } from "./protocol";
import type { BtwEvent, BtwThreadState } from "./btw-channels";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-store.test.ts )`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/btw-store.ts bun-apps/pi-agent-ext-webui/tests/btw-store.test.ts
git commit -m "feat(webui): add btw latest-snapshot store and broadcast forwarder"
```

