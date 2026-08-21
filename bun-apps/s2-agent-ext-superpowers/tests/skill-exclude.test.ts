import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_SKILL_EXCLUDE, superpowersExtension } from "../src/index.js";
import { createMockPi } from "./helpers/mock-pi.js";
import { allSkillDirNames } from "./helpers/skill-dirs.js";

/**
 * `PI_SUPERPOWERS_SKILL_EXCLUDE` knob + the Phase-3 default exclude.
 *
 * Phase-3 A/B-tests whether the LLM still behaves well when a Superpowers
 * skill is UNREGISTERED. `verification-before-completion` passed clean (the
 * model resists confidence-escalation without it), so it is excluded by DEFAULT
 * — `verification-before-completion` (~121 tok advertisement, Phase-3
 * clean-pass) and `using-superpowers` (~96 tok advertisement, bootstrap dedup —
 * its body is already injected by the bootstrap). See ADR-0008. Other skills
 * are unloaded only when listed in `PI_SUPERPOWERS_SKILL_EXCLUDE`.
 * `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` suppresses the default (e.g. a
 * probe fat-run that must load every skill).
 *
 * Representation: when the exclude set is NON-empty, the handler returns the
 * INDIVIDUAL skill-dir paths (each `<name>/` is a pi skill root: a dir whose
 * direct child `SKILL.md` makes pi treat it as a skill root and stop
 * recursing). When empty (defaults off + no env list), it returns the single
 * `skills/` dir (pi recurses into every `<name>/` itself), preserving the
 * common path and its dedup vs the run-dir `--skill <skills>` splice.
 *
 * Deterministic: no LLM, no network, no real Pi. Drives the extension against
 * the same in-memory mock used by bootstrap.test.ts.
 */

const skillsDir = join(import.meta.dir, "..", "skills");

const ENV_KEY = "PI_SUPERPOWERS_SKILL_EXCLUDE";
const DEFAULTS_KEY = "PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS";
// The REAL default exclude list (imported, not restated — ticket 02).
const DEFAULT_SKILLS = [...DEFAULT_SKILL_EXCLUDE];
const savedExclude = process.env[ENV_KEY];
const savedDefaults = process.env[DEFAULTS_KEY];

afterEach(() => {
  // Restore so test ordering / parallel runs never leak the knobs into siblings.
  for (const [key, val] of Object.entries({ [ENV_KEY]: savedExclude, [DEFAULTS_KEY]: savedDefaults })) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

describe("default exclude (Phase-3 clean-pass)", () => {
  it("excludes both default skills by default (v-b-c + using-superpowers); advertises every other skill as an individual dir", async () => {
    delete process.env[ENV_KEY];
    delete process.env[DEFAULTS_KEY];
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });

    expect(Array.isArray(result.skillPaths)).toBe(true);
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();

    // Every OTHER skill is advertised; the default-excluded one is gone.
    const expected = allSkillDirNames(skillsDir).filter((n) => !DEFAULT_SKILLS.includes(n));
    expect(advertised).toEqual(expected);
    for (const d of DEFAULT_SKILLS) expect(advertised).not.toContain(d);

    // Each advertised path is a real skill root (dir + SKILL.md), so pi loads
    // exactly that skill from it (dir-with-SKILL.md ⇒ skill root, no recurse).
    for (const p of result.skillPaths) {
      expect(existsSync(join(p, "SKILL.md"))).toBe(true);
    }
  });

  it("PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0 disables the default → single skills/ dir (all skills loaded)", async () => {
    delete process.env[ENV_KEY];
    process.env[DEFAULTS_KEY] = "0";
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    expect(result.skillPaths).toHaveLength(1);
    expect(basename(result.skillPaths[0])).toBe("skills");
    expect(existsSync(result.skillPaths[0])).toBe(true);
  });

  it("every falsy variant (0/false/no/off) disables the default", async () => {
    for (const v of ["0", "false", "no", "off", "FALSE", "Off"]) {
      delete process.env[ENV_KEY];
      process.env[DEFAULTS_KEY] = v;
      const pi = createMockPi();
      superpowersExtension(pi);
      const result = await pi.fire("resources_discover", { type: "resources_discover" });
      expect(result.skillPaths, `DEFAULTS=${v} should load all skills (single dir)`).toHaveLength(1);
    }
  });

  it("a truthy/unrecognized DEFAULTS value leaves the default ON", async () => {
    delete process.env[ENV_KEY];
    process.env[DEFAULTS_KEY] = "1"; // not a falsy token → defaults still applied
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();
    for (const d of DEFAULT_SKILLS) expect(advertised).not.toContain(d);
  });

  it("the default-excluded skills' pinned SKILL.md stay on disk byte-identical (ADR-0004 — unregister ≠ edit)", () => {
    // The knob must NOT touch files. This is a presence check here; the full
    // byte-equality pin lives in skills-fidelity.test.ts (which stays green).
    // verification-before-completion was DELETED (ticket 08, 2026-08-21) while
    // its exclude entry is deliberately KEPT — an entry naming a skill that no
    // longer ships is inert, so assert presence only for skills on disk.
    delete process.env[DEFAULTS_KEY];
    const onDisk = allSkillDirNames(skillsDir);
    for (const d of DEFAULT_SKILLS.filter((n) => onDisk.includes(n))) {
      expect(existsSync(join(skillsDir, d, "SKILL.md"))).toBe(true);
    }
    expect(DEFAULT_SKILLS.filter((n) => !onDisk.includes(n))).toEqual(["verification-before-completion"]);
  });
});

describe("explicit PI_SUPERPOWERS_SKILL_EXCLUDE knob", () => {
  it("composes with the default (env-listed skill AND verification-before-completion both excluded)", async () => {
    process.env[ENV_KEY] = "test-driven-development";
    delete process.env[DEFAULTS_KEY];
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();
    const expected = allSkillDirNames(skillsDir).filter(
      (n) => n !== "test-driven-development" && !DEFAULT_SKILLS.includes(n),
    );
    expect(advertised).toEqual(expected);
  });

  it("supports a comma-list and trims whitespace (composes with the default)", async () => {
    process.env[ENV_KEY] = " test-driven-development , systematic-debugging ,,";
    delete process.env[DEFAULTS_KEY];
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();
    const expected = allSkillDirNames(skillsDir).filter(
      (n) => n !== "test-driven-development" && n !== "systematic-debugging" && !DEFAULT_SKILLS.includes(n),
    );
    expect(advertised).toEqual(expected);
  });

  it("with DEFAULTS=0: a non-matching exclude entry flips to individual dirs but advertises every real skill", async () => {
    process.env[ENV_KEY] = "nonexistent-skill";
    process.env[DEFAULTS_KEY] = "0";
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();
    // An all-miss exclude list still flips representation to individual dirs
    // (the knob is "set"), but every real skill is advertised (default off).
    expect(advertised).toEqual(allSkillDirNames(skillsDir));
  });

  it("with DEFAULTS=0: omits the excluded skill and advertises every other skill — the default skill IS loaded (raw knob)", async () => {
    process.env[ENV_KEY] = "test-driven-development";
    process.env[DEFAULTS_KEY] = "0";
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    const advertised = (result.skillPaths as string[]).map((p) => basename(p)).sort();
    const expected = allSkillDirNames(skillsDir).filter((n) => n !== "test-driven-development");
    expect(advertised).toEqual(expected);
    // defaults suppressed → every default-excluded skill that still SHIPS is
    // loaded here (verification-before-completion no longer ships — ticket 08 —
    // so its kept exclude entry is inert by design)
    const onDisk = allSkillDirNames(skillsDir);
    for (const d of DEFAULT_SKILLS.filter((n) => onDisk.includes(n))) expect(advertised).toContain(d);
  });
});
