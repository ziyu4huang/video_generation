/**
 * registry-config.test.ts — the equivalence net (ticket 01,
 * .planning/2026-08-24-registry-code-as-config/).
 *
 * While the YAML stays authoritative, `registryToLegacyShapes()` must produce
 * EXACTLY what today's parsers return on the REAL s2-agent.registry.yaml —
 * these deep-equal assertions are the migration's safety net: as long as they
 * hold (locally and in CI), flipping consumers (tickets 02–03) and deleting
 * the YAML (ticket 04) is mechanical. Also asserts the module-level
 * invariants that used to live in YAML comments only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseRegistry } from "../run-dir/registry.ts";
import { parseShConfig } from "../../s2-agent-ext-devops/src/deploy/lib/config.ts";
import { REGISTRY, registryToLegacyShapes } from "./registry-config.ts";

const bunAppsDir = resolve(import.meta.dir, "../..");
const yamlPath = join(bunAppsDir, "s2-agent", "s2-agent.registry.yaml");

/**
 * Strip comments AND string literal contents, leaving only code tokens.
 * A naive `/* ... *​/` regex breaks on strings like "chromium-bidi/*" (a real
 * externals value), so this walks the source with a small state machine.
 * Template-literal interpolation is treated as string content — fine here:
 * the module's only template literals interpolate simple identifiers, and the
 * assertion targets import/require tokens, which never appear inside them.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let state: "code" | "block" | "line" | "squote" | "dquote" | "template" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    switch (state) {
      case "code":
        if (c === "/" && next === "*") {
          state = "block";
          i++;
        } else if (c === "/" && next === "/") {
          state = "line";
          i++;
        } else if (c === "'") {
          state = "squote";
        } else if (c === '"') {
          state = "dquote";
        } else if (c === "`") {
          state = "template";
        } else {
          out += c;
        }
        break;
      case "block":
        if (c === "*" && next === "/") {
          state = "code";
          i++;
        }
        break;
      case "line":
        if (c === "\n") {
          state = "code";
          out += c;
        }
        break;
      case "squote":
        if (c === "\\") i++;
        else if (c === "'") state = "code";
        break;
      case "dquote":
        if (c === "\\") i++;
        else if (c === '"') state = "code";
        break;
      case "template":
        if (c === "\\") i++;
        else if (c === "`") state = "code";
        break;
    }
  }
  return out;
}

describe("registry-config equivalence net (vs the real YAML)", () => {
  const yamlText = readFileSync(yamlPath, "utf8");
  const parsed = parseRegistry(yamlText, { bunAppsDir });
  const shParsed = parseShConfig(yamlText, { bunAppsDir });
  const shapes = registryToLegacyShapes({ home: homedir() });

  test("registryToLegacyShapes().registry deep-equals parseRegistry(yaml)", () => {
    expect(shapes.registry).toEqual(parsed);
  });

  test("registryToLegacyShapes().shConfig deep-equals parseShConfig(yaml)", () => {
    expect(shapes.shConfig).toEqual(shParsed);
  });

  test("active entry count matches the YAML parse (nothing silently dropped)", () => {
    expect(shapes.registry.extensions.map((e) => e.name)).toEqual(parsed.extensions.map((e) => e.name));
    expect(shapes.shConfig.extensions.map((e) => e.name)).toEqual(shParsed.extensions.map((e) => e.name));
  });
});

describe("registry-config invariants (rules that used to be YAML comments)", () => {
  test("every enabled entry without a deploy block carries a non-empty excludeReason", () => {
    const offenders = REGISTRY.filter((e) => e.enabled && e.deploy === undefined && !e.excludeReason);
    expect(offenders.map((e) => e.name)).toEqual([]);
  });

  test("no enabled entry carries both a deploy block and an excludeReason", () => {
    const offenders = REGISTRY.filter((e) => e.enabled && e.deploy !== undefined && e.excludeReason !== undefined);
    expect(offenders.map((e) => e.name)).toEqual([]);
  });

  test("every disabled entry carries a non-empty disableReason + reEnableNote (D2)", () => {
    const offenders = REGISTRY.filter(
      (e) => !e.enabled && (!e.disableReason || !e.reEnableNote),
    );
    expect(offenders.map((e) => e.name)).toEqual([]);
  });

  test("disabled entries are enumerated values, not deletions (hyperframes, tool-gate)", () => {
    expect(REGISTRY.filter((e) => !e.enabled).map((e) => e.name).sort()).toEqual(["hyperframes", "tool-gate"]);
  });

  test("extension names are unique", () => {
    const names = REGISTRY.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("registry-config module discipline", () => {
  test("registry-config.ts is import-free (map D4 — contract suites read it without workspace links)", () => {
    const src = readFileSync(join(import.meta.dir, "registry-config.ts"), "utf8");
    const code = stripCommentsAndStrings(src);
    expect(/^\s*import\b/m.test(code)).toBe(false);
    expect(/\brequire\s*\(/.test(code)).toBe(false);
  });
});
