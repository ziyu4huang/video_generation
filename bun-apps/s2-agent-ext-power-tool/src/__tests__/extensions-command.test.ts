/**
 * Tests for the /extensions slash command (s2-agent-ext-power-tool).
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

/** An item whose sourceInfo path embeds `s2-agent-ext-wayfind`. */
const wf = (name: string): Sourced => ({
  name,
  sourceInfo: { path: "/r/bun-apps/s2-agent-ext-wayfind/src/index.ts", source: "extension" },
});

/** An item whose sourceInfo path embeds `s2-agent-ext-superpowers`. */
const superSkill = (name: string): Sourced => ({
  name,
  sourceInfo: { path: "/r/bun-apps/s2-agent-ext-superpowers/skills/foo.md", source: "skill" },
});

/** A builtin/core item whose sourceInfo has no s2-agent-ext segment. */
const builtin = (name: string): Sourced => ({
  name,
  sourceInfo: { path: "/core/x.ts", source: "builtin" },
});

/** A REAL command entry (no top-level `source` → treated as a real command). */
const realCmd = (name: string): Sourced => ({
  name,
  sourceInfo: { path: "/r/bun-apps/s2-agent-ext-wayfind/src/index.ts", source: "extension" },
});

/** A skill-wrapped command — pi auto-generates `/skill:<name>` per loaded skill
 *  (top-level source: "skill"); attributes to `s2-agent-ext-<ext>`. */
const skillCmd = (ext: string, name: string): Sourced => ({
  name: `skill:${name}`,
  source: "skill",
  sourceInfo: { path: `/r/bun-apps/s2-agent-ext-${ext}/skills/${name}/SKILL.md`, source: "extension" },
});

/** A skill entry as it appears in ctx.getSystemPromptOptions().skills. */
const skillEntry = (ext: string, name: string): Sourced => ({
  name,
  sourceInfo: { path: `/r/bun-apps/s2-agent-ext-${ext}/skills/${name}/SKILL.md`, source: "extension" },
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
    expect(extName({ path: "/r/bun-apps/s2-agent-ext-wayfind/src/index.ts" })).toBe("wayfind");
  });

  test("extracts hyperframes from an npm source", () => {
    expect(extName({ source: "npm:@x/s2-agent-ext-hyperframes" })).toBe("hyperframes");
  });

  test("returns undefined for a user path with no s2-agent-ext", () => {
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
    // wayfind: 2 tools + 1 real command (no top-level source), 0 skill-aliases
    expect(groups.get("wayfind")?.tools).toEqual(["t1", "t2"]);
    expect(groups.get("wayfind")?.commands).toEqual(["c1"]);
    expect(groups.get("wayfind")?.skillCommands).toEqual([]);
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
    expect(out).toContain("s2-agent-ext-wayfind");
    expect(out).toContain("2 tool · 1 cmd · 0 skill");
  });
});

// ─── renderDetail ────────────────────────────────────────────────────────────

describe("renderDetail", () => {
  test("header + sections; (none) for empties", () => {
    const out = renderDetail("wayfind", {
      tools: ["t1", "t2"],
      commands: [],
      skills: [],
      skillCommands: [],
    });
    expect(out.startsWith("s2-agent-ext-wayfind")).toBe(true);
    expect(out).toContain("tools:");
    expect(out).toContain("commands:");
    expect(out).toContain("skills:");
    // empty sections show (none)
    expect(out).toContain("(none)");
    expect(out).toContain("t1");
    expect(out).toContain("t2");
  });
});

// ─── skill-command dedup (source: "skill") ───────────────────────────────────

describe("skill-command dedup", () => {
  test("groupByExtension routes skill-source commands to skillCommands, not commands", () => {
    const groups = groupByExtension({
      tools: [],
      commands: [realCmd("do-stuff"), skillCmd("superpowers", "alpha"), skillCmd("superpowers", "beta")],
      skills: [skillEntry("superpowers", "alpha"), skillEntry("superpowers", "beta")],
    });
    // superpowers: 0 real commands, 2 skill-aliases, 2 skills
    const sp = groups.get("superpowers")!;
    expect(sp.commands).toEqual([]);
    expect(sp.skillCommands).toEqual(["skill:alpha", "skill:beta"]);
    expect(sp.skills).toEqual(["alpha", "beta"]);
    // wayfind: 1 real command, no skill-aliases
    const wfG = groups.get("wayfind")!;
    expect(wfG.commands).toEqual(["do-stuff"]);
    expect(wfG.skillCommands).toEqual([]);
  });

  test("renderSummary: skill-only extension → `0 cmd (+N /skill:) · N skill`", () => {
    const groups = groupByExtension({
      tools: [],
      commands: [skillCmd("superpowers", "alpha"), skillCmd("superpowers", "beta")],
      skills: [skillEntry("superpowers", "alpha"), skillEntry("superpowers", "beta")],
    });
    const out = renderSummary(groups);
    expect(out).toContain("s2-agent-ext-superpowers");
    expect(out).toContain("0 tool · 0 cmd (+2 /skill:) · 2 skill");
    // the skill-aliases must NOT inflate the real command count
    expect(out).not.toMatch(/\b2 cmd\b/);
  });

  test("renderSummary: mixed extension → real cmd count + (+M /skill:)", () => {
    const groups = groupByExtension({
      tools: [],
      commands: [realCmd("wf-one"), skillCmd("wayfind", "gamma")],
      skills: [skillEntry("wayfind", "gamma")],
    });
    const out = renderSummary(groups);
    expect(out).toContain("s2-agent-ext-wayfind");
    expect(out).toContain("0 tool · 1 cmd (+1 /skill:) · 1 skill");
  });

  test("renderSummary: only-real extension → plain `N cmd`, no (+...)", () => {
    const groups = groupByExtension({
      tools: [],
      commands: [realCmd("c1"), realCmd("c2")],
      skills: [],
    });
    const out = renderSummary(groups);
    expect(out).toContain("s2-agent-ext-wayfind");
    expect(out).toContain("0 tool · 2 cmd · 0 skill");
    expect(out).not.toContain("/skill:");
  });

  test("renderDetail: skill-only lists NO commands but shows the invocable-as-skill note", () => {
    const groups = groupByExtension({
      tools: [],
      commands: [skillCmd("superpowers", "alpha"), skillCmd("superpowers", "beta")],
      skills: [skillEntry("superpowers", "alpha"), skillEntry("superpowers", "beta")],
    });
    const out = renderDetail("superpowers", groups.get("superpowers")!);
    expect(out).toContain("commands:");
    expect(out).toContain("(none)");
    // skill-alias wrappers must NOT appear listed under commands
    expect(out).not.toContain("skill:alpha");
    expect(out).not.toContain("skill:beta");
    // info preserved as a one-line note
    expect(out).toContain("(+2 skills also invocable as /skill:<name>)");
    // skills section stays intact
    expect(out).toContain("skills:");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  test("renderDetail: mixed lists real commands + note, hides skill-aliases", () => {
    const groups = groupByExtension({
      tools: [],
      commands: [realCmd("wf-one"), skillCmd("wayfind", "gamma")],
      skills: [skillEntry("wayfind", "gamma")],
    });
    const out = renderDetail("wayfind", groups.get("wayfind")!);
    expect(out).toContain("wf-one");
    expect(out).not.toContain("skill:gamma");
    expect(out).toContain("(+1 skills also invocable as /skill:<name>)");
  });

  test("renderDetail: only-real lists all commands, no note", () => {
    const groups = groupByExtension({
      tools: [],
      commands: [realCmd("c1"), realCmd("c2")],
      skills: [],
    });
    const out = renderDetail("wayfind", groups.get("wayfind")!);
    expect(out).toContain("c1");
    expect(out).toContain("c2");
    expect(out).not.toContain("invocable as /skill");
  });

  test("handler summary reflects skill-command dedup end-to-end", async () => {
    const cmd = makeExtensionsCommand(
      () => [],
      () => [skillCmd("superpowers", "alpha"), skillCmd("superpowers", "beta")],
    );
    const { ctx, notifyCalls } = mockCtx({
      selectReturns: undefined,
      skills: [skillEntry("superpowers", "alpha"), skillEntry("superpowers", "beta")],
    });
    await cmd.handler("", ctx as never);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].msg).toContain("0 cmd (+2 /skill:) · 2 skill");
    expect(notifyCalls[0].msg).not.toMatch(/\b2 cmd\b/);
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

  test("handler no-arg with select = s2-agent-ext-wayfind → detail", async () => {
    const cmd = makeExtensionsCommand(() => [wf("t1"), wf("t2")], () => [wf("c1")]);
    const { ctx, notifyCalls } = mockCtx({ selectReturns: "s2-agent-ext-wayfind" });
    await cmd.handler("", ctx as never);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].msg).toContain("s2-agent-ext-wayfind");
    expect(notifyCalls[0].msg).toContain("tools:");
  });

  test("handler arg 'wayfind' → detail", async () => {
    const cmd = makeExtensionsCommand(() => [wf("t1")], () => []);
    const { ctx, notifyCalls } = mockCtx({});
    await cmd.handler("wayfind", ctx as never);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].msg).toContain("s2-agent-ext-wayfind");
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
