import { test, expect, describe } from "bun:test";
import {
  KNOWN_EVENTS,
  collectHooks,
  analyzeHooks,
  formatHooksReport,
  type HooksSnapshot,
} from "../inspect-hooks.js";

const snap = (extensions: HooksSnapshot["extensions"], available = true): HooksSnapshot =>
  ({ extensions, available });

describe("collectHooks", () => {
  test("maps runner.extensions[] (Map<event,handler[]>) into ExtensionHooks[]", () => {
    const raw = [
      {
        path: "bun-apps/pi-agent-ext-foo/ext.ts",
        handlers: new Map([["turn_end", [() => {}, () => {}]], ["before_agent_start", [() => {}]]]),
      },
    ];
    expect(collectHooks(raw)).toEqual(
      snap([
        {
          path: "bun-apps/pi-agent-ext-foo/ext.ts",
          hooks: [
            { event: "turn_end", count: 2 },
            { event: "before_agent_start", count: 1 },
          ],
        },
      ]),
    );
  });

  test("returns available:false when input is not an array (SDK shape changed)", () => {
    expect(collectHooks(undefined)).toEqual(snap([], false));
    expect(collectHooks({})).toEqual(snap([], false));
  });

  test("tolerates a missing handlers map / missing path", () => {
    const raw = [{ path: "p" }, { handlers: new Map([["turn_end", [() => {}]]]) }];
    const out = collectHooks(raw);
    expect(out.available).toBe(true);
    expect(out.extensions[0]).toEqual({ path: "p", hooks: [] });
    expect(out.extensions[1]).toEqual({ path: "(unknown)", hooks: [{ event: "turn_end", count: 1 }] });
  });
});

describe("analyzeHooks", () => {
  test("flags handler on an UNKNOWN event as medium unknown-event-name", () => {
    const findings = analyzeHooks(snap([
      { path: "ext.ts", hooks: [{ event: "before_agent_starts", count: 1 }] }, // stray 's'
    ]));
    const f = findings.find((f) => f.check === "unknown-event-name")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("medium");
    expect(f.detail).toMatchObject({ event: "before_agent_starts", count: 1 });
  });

  test("does NOT flag a real event", () => {
    const findings = analyzeHooks(snap([
      { path: "ext.ts", hooks: [{ event: "turn_end", count: 1 }] },
    ]));
    expect(findings.some((f) => f.check === "unknown-event-name")).toBe(false);
  });

  test("emits per-extension inventory (info) + stats (info)", () => {
    const findings = analyzeHooks(snap([
      { path: "a.ts", hooks: [{ event: "turn_end", count: 2 }, { event: "context", count: 1 }] },
      { path: "b.ts", hooks: [{ event: "turn_end", count: 1 }] },
    ]));
    expect(findings.filter((f) => f.check === "extension-hook-inventory")).toHaveLength(2);
    const stats = findings.find((f) => f.check === "hook-stats")!;
    expect(stats.detail).toMatchObject({ extensions: 2, handlers: 4, unknown: 0 });
  });

  test("available:false → only a hooks-unavailable info finding", () => {
    const findings = analyzeHooks(snap([], false));
    expect(findings.map((f) => f.check)).toEqual(["hooks-unavailable"]);
  });
});

describe("formatHooksReport", () => {
  const snapshot = snap([
    { path: "bun-apps/ext-a/a.ts", hooks: [{ event: "turn_end", count: 2 }, { event: "nope", count: 1 }] },
  ]);
  test("text report includes the unknown-event message + inventory line", () => {
    const out = formatHooksReport(snapshot, analyzeHooks(snapshot), false);
    expect(out).toContain("Inspect Hooks");
    expect(out).toContain('unknown event "nope"');
    expect(out).toContain("ext-a/a.ts");
  });
  test("byEvent=true groups the inventory by event", () => {
    const out = formatHooksReport(snapshot, analyzeHooks(snapshot), true);
    expect(out).toContain("turn_end");
  });
});

describe("KNOWN_EVENTS", () => {
  test("includes the high-frequency events (sanity vs SDK drift)", () => {
    for (const e of ["session_start", "before_agent_start", "turn_end", "tool_execution_start", "context", "tool_call", "input"]) {
      expect(KNOWN_EVENTS.has(e)).toBe(true);
    }
  });
});
