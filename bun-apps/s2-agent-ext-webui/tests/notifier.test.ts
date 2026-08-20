import { test, expect, describe } from "bun:test";
import { BroadcastingNotifier } from "../src/notifier.js";
import { MemoryBroadcaster } from "../src/broadcaster.js";

describe("BroadcastingNotifier", () => {
  test("notifyBlocked broadcasts mutex_blocked with arg order (blocked, by)", () => {
    const sink = new MemoryBroadcaster();
    new BroadcastingNotifier(sink).notifyBlocked("web", "tui");
    expect(sink.frames).toEqual([{ type: "mutex_blocked", blocked: "web", by: "tui" }]);
  });
  test("notifyBlocked reverse direction", () => {
    const sink = new MemoryBroadcaster();
    new BroadcastingNotifier(sink).notifyBlocked("tui", "web");
    expect(sink.frames).toEqual([{ type: "mutex_blocked", blocked: "tui", by: "web" }]);
  });
  test("notifyForceRelease broadcasts mutex_force_release", () => {
    const sink = new MemoryBroadcaster();
    new BroadcastingNotifier(sink).notifyForceRelease("web");
    expect(sink.frames).toEqual([{ type: "mutex_force_release", driver: "web" }]);
  });
});
