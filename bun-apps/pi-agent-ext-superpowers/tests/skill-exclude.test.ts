import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { superpowersExtension } from "../src/index.js";

/**
 * `PI_SUPERPOWERS_SKILL_EXCLUDE` knob (Phase-3 skill-unload audit).
 *
 * Phase-3 A/B-tests whether the LLM still behaves well when a Superpowers
 * skill is UNREGISTERED. The knob takes a comma-list of skill dir-names; any
 * listed skill is dropped from the `resources_discover` advertisement so pi
 * never registers it. The pinned `SKILL.md` file stays on disk byte-identical
 * (ADR-0004 — unregister ≠ edit); `skills-fidelity.test.ts` is the guard for
 * that invariant and stays green here.
 *
 * Representation: when the exclude list is NON-empty, the handler returns the
 * INDIVIDUAL skill-dir paths (each `<name>/` is a pi skill root: a dir whose
 * direct child `SKILL.md` makes pi treat it as a skill root and stop
 * recursing). When the list is empty, it returns the single `skills/` dir
 * (current behavior — pi recurses into every `<name>/` itself), so the common
 * path and its dedup vs the run-dir `--skill <skills>` splice are unchanged.
 *
 * Deterministic: no LLM, no network, no real Pi. Drives the extension against
 * the same in-memory mock used by bootstrap.test.ts.
 */

type Handler = (event: any, ctx?: any) => any;

function createMockPi(): ExtensionAPI & { handlers: Map<string, Handler>; fire: (e: string, ev?: any) => any } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    sendUserMessage: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const fire = (event: string, ev: any = {}) => handlers.get(event)?.(ev);
  return { ...pi, handlers, fire } as any;
}

const skillsDir = join(import.meta.dir, "..", "skills");

/** All immediate skill subdirs of skills/ (the dir-names the exclude list keys on). */
function allSkillDirNames(): string[] {
  return readdirSync(skillsDir)
    .filter((entry) => statSync(join(skillsDir, entry)).isDirectory())
    .sort();
}

const ENV_KEY = "PI_SUPERPOWERS_SKILL_EXCLUDE";
const saved = process.env[ENV_KEY];

afterEach(() => {
  // Restore so test ordering / parallel runs never leak the knob into siblings.
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("PI_SUPERPOWERS_SKILL_EXCLUDE knob", () => {
  it("returns the single skills/ dir when the knob is unset (current behavior preserved)", async () => {
    delete process.env[ENV_KEY];
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    expect(result.skillPaths).toHaveLength(1);
    expect(basename(result.skillPaths[0])).toBe("skills");
    expect(existsSync(result.skillPaths[0])).toBe(true);
  });

  it("returns the single skills/ dir when the knob is an empty string", async () => {
    process.env[ENV_KEY] = "   ,  ";
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    expect(result.skillPaths).toHaveLength(1);
    expect(basename(result.skillPaths[0])).toBe("skills");
  });

  it("omits the excluded skill and advertises every other skill as an individual dir", async () => {
    process.env[ENV_KEY] = "test-driven-development";
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });

    expect(Array.isArray(result.skillPaths)).toBe(true);
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();

    // Every OTHER skill is still advertised; the excluded one is gone.
    const expected = allSkillDirNames().filter((n) => n !== "test-driven-development");
    expect(advertised).toEqual(expected);
    expect(advertised).not.toContain("test-driven-development");

    // Each advertised path is a real skill root (dir + SKILL.md), so pi loads
    // exactly that skill from it (dir-with-SKILL.md ⇒ skill root, no recurse).
    for (const p of result.skillPaths) {
      expect(existsSync(join(p, "SKILL.md"))).toBe(true);
    }
  });

  it("the excluded skill's pinned SKILL.md file stays on disk byte-identical (ADR-0004 — unregister ≠ edit)", () => {
    // The knob must NOT touch files. This is a presence check here; the full
    // byte-equality pin lives in skills-fidelity.test.ts (which stays green).
    process.env[ENV_KEY] = "test-driven-development";
    expect(existsSync(join(skillsDir, "test-driven-development", "SKILL.md"))).toBe(true);
  });

  it("supports a comma-list and trims whitespace", async () => {
    process.env[ENV_KEY] = " test-driven-development , systematic-debugging ,,";
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();
    const expected = allSkillDirNames().filter((n) => n !== "test-driven-development" && n !== "systematic-debugging");
    expect(advertised).toEqual(expected);
  });

  it("ignores exclude entries that do not match a real skill dir (no error, no effect for those)", async () => {
    process.env[ENV_KEY] = "nonexistent-skill";
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();
    // An all-miss exclude list still flips representation to individual dirs
    // (the knob is "set"), but every real skill is advertised.
    expect(advertised).toEqual(allSkillDirNames());
  });
});
