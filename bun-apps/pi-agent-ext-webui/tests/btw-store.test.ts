import { describe, expect, it } from "bun:test";
import type { WebFrame } from "../src/protocol.js";
import { createBtwForwarder, createBtwStore } from "../src/btw-store.js";
import type { BtwEvent, BtwThreadState } from "../src/btw-channels.js";

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
