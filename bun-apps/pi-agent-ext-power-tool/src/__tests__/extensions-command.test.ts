/**
 * Tests for the /extensions slash command (pi-agent-ext-power-tool).
 *
 * Covers the pure helpers (extName, groupByExtension, renderSummary,
 * renderDetail) and the command factory's handler + getArgumentCompletions via
 * mocked closures + a mock command context (no framework needed).
 */
import { describe, expect, test } from "bun:test";
import {
  extName,
  groupByExtension,
  makeExtensionsCommand,
  OTHER,
  renderDetail,
  renderSummary,
  type Sourced,
} from "../extensions-command.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** An item whose sourceInfo path embeds `pi-agent-ext-wayfind`. */
const wf = (name: string): Sourced => ({
  name,
  sourceInfo: { path: "/r/bun-apps/pi-agent-ext-wayfind/src/index.ts", source: "extension" },
});

/** An item whose sourceInfo path embeds `pi-agent-ext-superpowers`. */
const superSkill = (name: string): Sourced => ({
  name,
  sourceInfo: { path: "/r/bun-apps/pi-agent-ext-superpowers/skills/foo.md", source: "skill" },
});

/** A builtin/core item whose sourceInfo has no pi-agent-ext segment. */
const builtin = (name: string): Sourced => ({
  name,
  sourceInfo: { path: "/core/x.ts", source: "builtin" },
});

// ─── Mock command context ────────────────────────────────────────────────────

interface NotifyCall {
  msg: string;
  level?: string;
}

function mockCtx(opts: { skills?: Sourced[]; selectReturns?: string | undefined }) {
  const notifyCalls: NotifyCall[] = [];
  const ctx = {
    getSystemPromptOptions: () => ({ skills: opts.skills ?? [] }),
    ui: {
      notify: (msg: string, level?: string) => {
        notifyCalls.push({ msg, level });
      },
      select: async (_title: string, _options: string[]) => opts.selectReturns,
    },
  };
  return { ctx, notifyCalls };
}

// ─── extName ─────────────────────────────────────────────────────────────────

describe("extName", () => {
  test("extracts wayfind from a path", () => {
    expect(extName({ path: "/r/bun-apps/pi-agent-ext-wayfind/src/index.ts" })).toBe("wayfind");
  });

  test("extracts hyperframes from an npm source", () => {
    expect(extName({ source: "npm:@x/pi-agent-ext-hyperframes" })).toBe("hyperframes");
  });

  test("returns undefined for a user path with no pi-agent-ext", () => {
    expect(extName({ path: "/home/user/some/path.ts" })).toBeUndefined();
  });

  test("returns undefined when sourceInfo is absent", () => {
    expect(extName(undefined)).toBeUndefined();
  });
});

// ─── groupByExtension ────────────────────────────────────────────────────────

describe("groupByExtension", () => {
  test("buckets by owning extension, sorted alpha with OTHER last", () => {
    const groups = groupByExtension({
      tools: [wf("t1"), wf("t2"), builtin("bash")],
      commands: [wf("c1")],
      skills: [superSkill("skillX")],
    });
    expect([...groups.keys()]).toEqual(["superpowers", "wayfind", OTHER]);
    // wayfind: 2 tools + 1 command
    expect(groups.get("wayfind")?.tools).toEqual(["t1", "t2"]);
    expect(groups.get("wayfind")?.commands).toEqual(["c1"]);
    expect(groups.get("wayfind")?.skills).toEqual([]);
    // superpowers: 1 skill
    expect(groups.get("superpowers")?.skills).toEqual(["skillX"]);
    expect(groups.get("superpowers")?.tools).toEqual([]);
    // OTHER: the builtin tool
    expect(groups.get(OTHER)?.tools).toEqual(["bash"]);
  });
});

// ─── renderSummary ───────────────────────────────────────────────────────────

describe("renderSummary", () => {
  test("header + one line per extension with counts", () => {
    const groups = groupByExtension({
      tools: [wf("t1"), wf("t2"), builtin("bash")],
      commands: [wf("c1")],
      skills: [superSkill("skillX")],
    });
    const out = renderSummary(groups);
    expect(out).toContain("Loaded extensions:");
    expect(out).toContain("pi-agent-ext-wayfind");
    expect(out).toContain("2 tool · 1 cmd · 0 skill");
  });
});

// ─── renderDetail ────────────────────────────────────────────────────────────

describe("renderDetail", () => {
  test("header + sections; (none) for empties", () => {
    const out = renderDetail("wayfind", { tools: ["t1", "t2"], commands: [], skills: [] });
    expect(out.startsWith("pi-agent-ext-wayfind")).toBe(true);
    expect(out).toContain("tools:");
    expect(out).toContain("commands:");
    expect(out).toContain("skills:");
    // empty sections show (none)
    expect(out).toContain("(none)");
    expect(out).toContain("t1");
    expect(out).toContain("t2");
  });
});

// ─── makeExtensionsCommand ───────────────────────────────────────────────────

describe("makeExtensionsCommand", () => {
  test("handler no-arg with select cancelled → summary", async () => {
    const cmd = makeExtensionsCommand(() => [wf("t1"), wf("t2")], () => [wf("c1")]);
    const { ctx, notifyCalls } = mockCtx({ selectReturns: undefined });
    await cmd.handler("", ctx as never);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].msg).toContain("Loaded extensions:");
  });

  test("handler no-arg with select = pi-agent-ext-wayfind → detail", async () => {
    const cmd = makeExtensionsCommand(() => [wf("t1"), wf("t2")], () => [wf("c1")]);
    const { ctx, notifyCalls } = mockCtx({ selectReturns: "pi-agent-ext-wayfind" });
    await cmd.handler("", ctx as never);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].msg).toContain("pi-agent-ext-wayfind");
    expect(notifyCalls[0].msg).toContain("tools:");
  });

  test("handler arg 'wayfind' → detail", async () => {
    const cmd = makeExtensionsCommand(() => [wf("t1")], () => []);
    const { ctx, notifyCalls } = mockCtx({});
    await cmd.handler("wayfind", ctx as never);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].msg).toContain("pi-agent-ext-wayfind");
    expect(notifyCalls[0].msg).toContain("tools:");
  });

  test("handler arg 'nope' → no-extension message", async () => {
    const cmd = makeExtensionsCommand(() => [wf("t1")], () => []);
    const { ctx, notifyCalls } = mockCtx({});
    await cmd.handler("nope", ctx as never);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].msg).toContain("No extension");
  });

  test("getArgumentCompletions('') → includes wayfind", () => {
    const cmd = makeExtensionsCommand(() => [wf("t1")], () => [wf("c1")]);
    const all = cmd.getArgumentCompletions?.("") as { value: string }[] | null;
    expect(all).not.toBeNull();
    expect(all?.some((i) => i.value === "wayfind")).toBe(true);
  });

  test("getArgumentCompletions('way') → filtered to wayfind", () => {
    const cmd = makeExtensionsCommand(() => [wf("t1")], () => [wf("c1")]);
    const filtered = cmd.getArgumentCompletions?.("way") as { value: string }[] | null;
    expect(filtered).not.toBeNull();
    expect(filtered?.every((i) => i.value === "wayfind")).toBe(true);
  });

  test("getArgumentCompletions('zzz') → null", () => {
    const cmd = makeExtensionsCommand(() => [wf("t1")], () => [wf("c1")]);
    expect(cmd.getArgumentCompletions?.("zzz")).toBeNull();
  });
});
