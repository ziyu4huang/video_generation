import { test, expect, describe } from "bun:test";
import { analyzeHooks, formatHooksReport } from "../inspect-hooks.js";
import { KNOWN_EVENTS, collectHooks, type HooksSnapshot } from "../../runner-hooks.js";

const snap = (extensions: HooksSnapshot["extensions"], available = true): HooksSnapshot =>
  ({ extensions, available });

describe("collectHooks", () => {
  test("maps runner.extensions[] (Map<event,handler[]>) into ExtensionHooks[]", () => {
    const raw = [
      {
        path: "bun-apps/s2-agent-ext-foo/ext.ts",
        handlers: new Map([["turn_end", [() => {}, () => {}]], ["before_agent_start", [() => {}]]]),
      },
    ];
    expect(collectHooks(raw)).toEqual(
      snap([
        {
          path: "bun-apps/s2-agent-ext-foo/ext.ts",
          hooks: [
            { event: "turn_end", count: 2, fired: 0 },
            { event: "before_agent_start", count: 1, fired: 0 },
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
    expect(out.extensions[1]).toEqual({ path: "(unknown)", hooks: [{ event: "turn_end", count: 1, fired: 0 }] });
  });
});

describe("analyzeHooks", () => {
  test("flags handler on an UNKNOWN event as medium unknown-event-name", () => {
    const findings = analyzeHooks(snap([
      { path: "ext.ts", hooks: [{ event: "before_agent_starts", count: 1, fired: 0 }] }, // stray 's'
    ]));
    const f = findings.find((f) => f.check === "unknown-event-name")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("medium");
    expect(f.detail).toMatchObject({ event: "before_agent_starts", count: 1 });
  });

  test("does NOT flag a real event", () => {
    const findings = analyzeHooks(snap([
      { path: "ext.ts", hooks: [{ event: "turn_end", count: 1, fired: 0 }] },
    ]));
    expect(findings.some((f) => f.check === "unknown-event-name")).toBe(false);
  });

  test("emits per-extension inventory (info) + stats (info)", () => {
    const findings = analyzeHooks(snap([
      { path: "a.ts", hooks: [{ event: "turn_end", count: 2, fired: 0 }, { event: "context", count: 1, fired: 0 }] },
      { path: "b.ts", hooks: [{ event: "turn_end", count: 1, fired: 0 }] },
    ]));
    expect(findings.filter((f) => f.check === "extension-hook-inventory")).toHaveLength(2);
    const stats = findings.find((f) => f.check === "hook-stats")!;
    expect(stats.detail).toMatchObject({ extensions: 2, handlers: 4, unknown: 0 });
  });

  test("available:false → only a hooks-unavailable info finding", () => {
    const findings = analyzeHooks(snap([], false));
    expect(findings.map((f) => f.check)).toEqual(["hooks-unavailable"]);
  });

  // ── Phase 2 (Task 2): never-fired finding ────────────────────────────────
  test("never-fired: emits a low finding ONLY for fired===0 entries", () => {
    const findings = analyzeHooks(snap([
      { path: "bun-apps/ext-a/a.ts", hooks: [{ event: "turn_end", count: 1, fired: 3 }] },
      { path: "bun-apps/ext-b/b.ts", hooks: [{ event: "tool_call", count: 2, fired: 0 }, { event: "context", count: 1, fired: 0 }] },
    ]));
    const nf = findings.filter((f) => f.check === "never-fired");
    expect(nf).toHaveLength(2); // only the two fired===0 entries
    for (const f of nf) {
      expect(f.severity).toBe("low");
      expect(f.detail).toMatchObject({ fired: 0 });
    }
    // exact detail shape + message for the tool_call never-fired entry
    const tc = nf.find((f) => (f.detail as { event: string }).event === "tool_call")!;
    expect(tc.detail).toEqual({ path: "bun-apps/ext-b/b.ts", event: "tool_call", count: 2, fired: 0 });
    expect(tc.message).toBe('bun-apps/ext-b/b.ts handler on "tool_call" never fired (0/2)');
    // the fired>0 turn_end entry is NOT flagged
    expect(nf.some((f) => (f.detail as { event: string }).event === "turn_end")).toBe(false);
  });

  test("never-fired: NONE emitted when every hook fired > 0", () => {
    const findings = analyzeHooks(snap([
      { path: "ext.ts", hooks: [{ event: "turn_end", count: 1, fired: 1 }, { event: "context", count: 2, fired: 5 }] },
    ]));
    expect(findings.filter((f) => f.check === "never-fired")).toHaveLength(0);
  });
});

describe("formatHooksReport", () => {
  const snapshot = snap([
    { path: "bun-apps/ext-a/a.ts", hooks: [{ event: "turn_end", count: 2, fired: 0 }, { event: "nope", count: 1, fired: 0 }] },
  ]);
  test("text report includes the unknown-event message + inventory line", () => {
    const out = formatHooksReport(snapshot, analyzeHooks(snapshot), false);
    expect(out).toContain("Inspect Hooks");
    expect(out).toContain('unknown event "nope"');
    expect(out).toContain("ext-a/a.ts");
  });
  test("byEvent=true groups the inventory by event (and lists which extensions)", () => {
    const out = formatHooksReport(snapshot, analyzeHooks(snapshot), true);
    expect(out).toContain("Hooks by event:");
    expect(out).toContain("turn_end");
    expect(out).toContain("ext-a/a.ts"); // the who-list (Fix 1)
  });

  // ── Phase 2 (Task 2): fires column + never-fired section ────────────────
  test("never-fired section + fires column rendered when fired===0 exists", () => {
    const snapshot2 = snap([
      { path: "bun-apps/ext-a/a.ts", hooks: [{ event: "turn_end", count: 1, fired: 2 }, { event: "tool_call", count: 1, fired: 0 }] },
    ]);
    const out = formatHooksReport(snapshot2, analyzeHooks(snapshot2), false);
    // fires column present with per-extension aggregate value (2 = 2 + 0)
    expect(out).toContain("fires");
    expect(out).toContain("2 fires");
    // never-fired low section heading + message
    expect(out).toContain("Low — never fired");
    expect(out).toContain('handler on "tool_call" never fired (0/1)');
  });

  test("byEvent fires column aggregated per event", () => {
    const snapshot3 = snap([
      { path: "bun-apps/ext-a/a.ts", hooks: [{ event: "turn_end", count: 1, fired: 2 }] },
      { path: "bun-apps/ext-b/b.ts", hooks: [{ event: "turn_end", count: 1, fired: 3 }] },
    ]);
    const out = formatHooksReport(snapshot3, analyzeHooks(snapshot3), true);
    expect(out).toContain("fires");
    expect(out).toContain("5 fires"); // 2 + 3 aggregated across both extensions
  });

  test("never-fired section absent when all hooks fired > 0", () => {
    const snapshot4 = snap([
      { path: "ext.ts", hooks: [{ event: "turn_end", count: 1, fired: 4 }] },
    ]);
    const out = formatHooksReport(snapshot4, analyzeHooks(snapshot4), false);
    expect(out).not.toContain("Low — never fired");
    expect(out).not.toContain("never fired");
  });
});

describe("KNOWN_EVENTS", () => {
  test("includes the high-frequency events (sanity vs SDK drift)", () => {
    for (const e of ["session_start", "before_agent_start", "turn_end", "tool_execution_start", "context", "tool_call", "input"]) {
      expect(KNOWN_EVENTS.has(e)).toBe(true);
    }
  });
});

import { makeInspectHooksTool } from "../inspect-hooks.js";

describe("inspect_hooks (tool end-to-end, fake ctx)", () => {
  const fakeCtx = (snapshot: HooksSnapshot) =>
    ({ getHooks: () => snapshot } as unknown as Parameters<
      ReturnType<typeof makeInspectHooksTool>["execute"]
    >[4]);

  test("text report surfaces unknown-event finding", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute(
      "id",
      {},
      undefined,
      undefined,
      fakeCtx(snap([{ path: "ext.ts", hooks: [{ event: "turn_starts", count: 1, fired: 0 }] }])),
    );
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('unknown event "turn_starts"');
  });

  test("return_json=true returns {findings, summary, snapshot}", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute(
      "id",
      { return_json: true },
      undefined,
      undefined,
      fakeCtx(snap([{ path: "ext.ts", hooks: [{ event: "turn_end", count: 2, fired: 0 }] }])),
    );
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    // turn_end fired:0 → 1 never-fired (low) finding (Phase 2 task 2)
    expect(parsed.summary).toEqual({ total: 1, high: 0, medium: 0, low: 1 });
    expect(parsed.snapshot.extensions[0]).toEqual({
      path: "ext.ts",
      hooks: [{ event: "turn_end", count: 2, fired: 0 }],
    });
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  test("self_test=true returns deterministic mock (no live ctx)", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute("id", { self_test: true }, undefined, undefined, {} as never);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("self_test");
    expect(text).toContain("Inspect Hooks");
  });

  test("hooks-unavailable (available:false) degrades gracefully", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute("id", {}, undefined, undefined, fakeCtx(snap([], false)));
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Hooks unavailable");
  });
});
