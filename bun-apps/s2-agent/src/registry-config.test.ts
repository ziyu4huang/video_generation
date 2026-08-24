/**
 * registry-config.test.ts — the registry invariants (ticket 04,
 * .planning/2026-08-24-registry-code-as-config/).
 *
 * With the retired registry YAML gone, these tests are the registry's rule
 * layer: the rules that used to live in YAML comments (static order,
 * host-contract equality, excludeReason completeness, disabled-entry
 * metadata) are now executable assertions over the typed REGISTRY. The
 * pre-retirement equivalence net (TS ≡ YAML deep-equals) died with the YAML —
 * there is no second source to be equivalent to anymore.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HOST_API, HOST_MODULE_IDS } from "./sh/host-modules.ts";
import { HOST_CONTRACT, REGISTRY } from "./registry-config.ts";

const BUN_APPS = resolve(import.meta.dir, "../..");

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

  test("static entries order: subagent before ultracode (registry population order)", () => {
    const idx = (name: string) => REGISTRY.findIndex((e) => e.name === name);
    expect(idx("subagent")).toBeGreaterThanOrEqual(0);
    expect(idx("ultracode")).toBeGreaterThan(idx("subagent"));
    expect(REGISTRY[idx("subagent")]!.load).toBe("static");
    expect(REGISTRY[idx("ultracode")]!.load).toBe("static");
  });
});

describe("registry-config host contract (vs src/sh/host-modules.ts)", () => {
  test("HOST_CONTRACT.hostApi equals the core's HOST_API", () => {
    expect(HOST_CONTRACT.hostApi).toBe(HOST_API);
  });

  test("HOST_CONTRACT.hostModules set-equals the core's HOST_MODULE_IDS", () => {
    // Set-equal, not array-equal: module order is a core detail; the contract
    // is that every module the registry promises is actually embedded.
    expect([...HOST_CONTRACT.hostModules].sort()).toEqual([...HOST_MODULE_IDS].sort());
  });
});

describe("registry-config data integrity (module-internal + on-disk)", () => {
	/**
	 * On-disk extension dirs = s2-agent-ext-* dirs that carry a package.json.
	 * A dir WITHOUT one is a husk — typically node_modules-only rename fallout
	 * (s2-agent-ext-workflow survived on disk for 2+ days after the #1791
	 * ultracode rename and false-reded this scan on machines that never
	 * cleaned it). Untracked, so sync/submodule flows never remove it.
	 */
	function extPackageDirs(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true })
			.filter(
				(d) =>
					d.isDirectory() &&
					d.name.startsWith("s2-agent-ext-") &&
					existsSync(join(dir, d.name, "package.json")),
			)
			.map((d) => d.name)
			.sort();
	}

	test("one registry entry per bun-apps/s2-agent-ext-* folder", () => {
		const extDirs = extPackageDirs(BUN_APPS);
		const packages = REGISTRY.map((e) => e.package).sort();
		// Every entry points at an existing folder exactly once, and every ext
		// folder is registered — a scaffolded-but-unregistered extension is the
		// comment-out failure mode (D2) by another name.
		expect(packages).toEqual(extDirs);
	});

	test("husk dirs (no package.json) are not extensions", () => {
		// Pin the husk rule with a hermetic temp tree: a real ext dir (has
		// package.json), a rename husk (only node_modules inside), and a
		// non-ext dir — only the real one counts.
		const tmp = mkdtempSync(join(tmpdir(), "registry-husk-"));
		try {
			mkdirSync(join(tmp, "s2-agent-ext-real", "src"), { recursive: true });
			writeFileSync(join(tmp, "s2-agent-ext-real", "package.json"), "{}");
			mkdirSync(join(tmp, "s2-agent-ext-husk", "node_modules", "x"), { recursive: true });
			mkdirSync(join(tmp, "not-an-ext"), { recursive: true });
			expect(extPackageDirs(tmp)).toEqual(["s2-agent-ext-real"]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

  test("every entry's package dir and entry file exist on disk", () => {
    const missing = REGISTRY.filter(
      (e) => !existsSync(join(BUN_APPS, e.package)) || !existsSync(join(BUN_APPS, e.package, e.entry)),
    ).map((e) => e.name);
    expect(missing).toEqual([]);
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
