import { describe, expect, it } from "bun:test";
import type { MutexNotifier } from "../src/mutex-controller.js";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import { makeMutexNotifier } from "../src/notifier.js";

/**
 * notifier.test.ts — MutexNotifier-over-Broadcaster adapter (spec §3
 * "MutexNotifier implementation"). Mirrors the ticket-03 controller tests'
 * arg-order pinning: `notifyBlocked(blocked, by)` MUST broadcast blocked first,
 * by second. The sink is the in-memory {@link MemoryBroadcaster} test adapter.
 */

describe("makeMutexNotifier routing", () => {
  it("notifyBlocked('web','tui') broadcasts exactly {type:'mutex_blocked', blocked:'web', by:'tui'}", () => {
    const sink = new MemoryBroadcaster();
    const n = makeMutexNotifier(sink);
    n.notifyBlocked("web", "tui");
    expect(sink.frames).toEqual([{ type: "mutex_blocked", blocked: "web", by: "tui" }]);
  });

  it("notifyBlocked('tui','web') broadcasts exactly {type:'mutex_blocked', blocked:'tui', by:'web'}", () => {
    const sink = new MemoryBroadcaster();
    const n = makeMutexNotifier(sink);
    n.notifyBlocked("tui", "web");
    expect(sink.frames).toEqual([{ type: "mutex_blocked", blocked: "tui", by: "web" }]);
  });

  it("arg ORDER is blocked-first, by-second (mirrors the MutexNotifier contract)", () => {
    const sink = new MemoryBroadcaster();
    const n = makeMutexNotifier(sink);
    // Same two args, swapped order across two calls — each must land verbatim.
    n.notifyBlocked("web", "tui");
    n.notifyBlocked("tui", "web");
    expect(sink.frames).toEqual([
      { type: "mutex_blocked", blocked: "web", by: "tui" },
      { type: "mutex_blocked", blocked: "tui", by: "web" },
    ]);
  });

  it("notifyForceRelease(driver) broadcasts exactly {type:'mutex_force_release', driver}", () => {
    const sink = new MemoryBroadcaster();
    const n = makeMutexNotifier(sink);
    n.notifyForceRelease("tui");
    expect(sink.frames).toEqual([{ type: "mutex_force_release", driver: "tui" }]);
  });

  it("notifyForceRelease is symmetric for the web driver", () => {
    const sink = new MemoryBroadcaster();
    const n = makeMutexNotifier(sink);
    n.notifyForceRelease("web");
    expect(sink.frames).toEqual([{ type: "mutex_force_release", driver: "web" }]);
  });

  it("broadcasts one frame per call, in order, across mixed calls", () => {
    const sink = new MemoryBroadcaster();
    const n = makeMutexNotifier(sink);
    n.notifyBlocked("web", "tui");
    n.notifyForceRelease("tui");
    n.notifyBlocked("tui", "web");
    expect(sink.frames).toEqual([
      { type: "mutex_blocked", blocked: "web", by: "tui" },
      { type: "mutex_force_release", driver: "tui" },
      { type: "mutex_blocked", blocked: "tui", by: "web" },
    ]);
  });

  it("is pure/deterministic: same args -> same single frame, no other side effects", () => {
    const sinkA = new MemoryBroadcaster();
    const sinkB = new MemoryBroadcaster();
    const a = makeMutexNotifier(sinkA);
    const b = makeMutexNotifier(sinkB);
    a.notifyBlocked("web", "tui");
    b.notifyBlocked("web", "tui");
    expect(sinkA.frames).toEqual(sinkB.frames);
    expect(sinkA.frames).toHaveLength(1);
  });
});

describe("makeMutexNotifier interface conformance", () => {
  it("the returned object is assignable to MutexNotifier (typecheck-level)", () => {
    const n: MutexNotifier = makeMutexNotifier(new MemoryBroadcaster());
    // Both contract methods are present and callable.
    expect(typeof n.notifyBlocked).toBe("function");
    expect(typeof n.notifyForceRelease).toBe("function");
  });
});
