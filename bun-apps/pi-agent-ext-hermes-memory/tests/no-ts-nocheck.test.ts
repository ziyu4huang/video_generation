/**
 * Structural guard: this package must stay free of `@ts-nocheck`.
 *
 * Why a test and not just a code review: the directive that prompted this file
 * had ALREADY gone stale. `src/tools/grill-decision-tool.ts` carried the
 * directive from the era when pi-agent's static import first exposed this
 * package to a type-checker (see pi-agent/src/static-extensions.ts). The errors
 * it silenced were fixed by later store refactors, but nobody came back to
 * remove it — and pi-agent's own header had been updated to claim "both
 * suppressions are gone and the package type-checks clean", which was true of
 * the errors and false of the directive.
 *
 * That is the failure mode this guards: `tsc --noEmit` passes either way, so a
 * suppression can outlive its cause indefinitely without a single red signal.
 * `check` proves the code has no errors; this proves nothing is hiding them.
 *
 * Scope is deliberately this package only. web-access still has one legitimate
 * suppression (its index.ts, a closure-structure problem, not type debt), so a
 * repo-wide version of this assertion would fail today for a tracked reason.
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { Glob } from "bun";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * TypeScript honors `@ts-nocheck` only in a file's leading comment block —
 * once a statement appears, a later occurrence is inert text. Scanning the
 * whole file therefore reports things that suppress nothing: the first draft of
 * this guard failed on `memory-tool.ts`, where a sentence explaining why the
 * directive was REMOVED happens to wrap so that `@ts-nocheck` lands at the
 * start of line 308. Matching the checker's own rule removes that entire class
 * of false positive, and keeps the guard from discouraging the explanation.
 */
function prologue(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      kept.push(line);
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t === "" || t.startsWith("//")) {
      kept.push(line);
      continue;
    }
    if (t.startsWith("/*")) {
      kept.push(line);
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    break; // first statement — nothing past here can suppress the checker
  }
  return kept.join("\n");
}

const DIRECTIVE = /@ts-nocheck\b/;

describe("no @ts-nocheck in hermes-memory", () => {
  it("no source file suppresses type-checking", () => {
    const offenders: string[] = [];
    for (const pattern of ["src/**/*.ts", "extensions/*.ts", "*.ts"]) {
      for (const file of new Glob(pattern).scanSync({ cwd: PKG_ROOT, absolute: true })) {
        if (DIRECTIVE.test(prologue(readFileSync(file, "utf8")))) {
          offenders.push(relative(PKG_ROOT, file));
        }
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `@ts-nocheck suppresses the checker in: ${offenders.join(", ")}. ` +
        "Fix the errors instead — if they are genuinely unfixable here, move the " +
        "code to its own module so the suppression is scoped to it, and say why.",
    );
  });

  it("scans the prologue and stops at the first statement", () => {
    // Guards the guard. A prologue() that returned everything would resurrect
    // the memory-tool.ts false positive; one that returned nothing would pass
    // forever while proving nothing.
    assert.ok(DIRECTIVE.test(prologue("// @ts-nocheck\nconst a = 1;\n")));
    assert.ok(DIRECTIVE.test(prologue("/* @ts-nocheck */\nconst a = 1;\n")));
    assert.ok(DIRECTIVE.test(prologue("/**\n * @ts-nocheck\n */\nconst a = 1;\n")));
    assert.ok(DIRECTIVE.test(prologue("\n// leading blank line\n// @ts-nocheck\nexport {};\n")));

    // Past the first statement the directive is inert — this is the real shape
    // of memory-tool.ts:308, a wrapped sentence about the removed directive.
    assert.ok(!DIRECTIVE.test(prologue("import x from 'y';\n// silenced with\n// @ts-nocheck. defineTool instead.\n")));
    assert.ok(!DIRECTIVE.test(prologue("const s = 1;\n/* @ts-nocheck */\n")));
    assert.ok(!DIRECTIVE.test(prologue("// a normal header\nexport const a = 1;\n")));
  });
});
