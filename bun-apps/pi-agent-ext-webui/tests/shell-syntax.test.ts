/**
 * shell-syntax.test.ts — THE gate that catches broken shipped JS. A syntax
 * error anywhere in a <script> block kills the ENTIRE shell boot (tabs never
 * render, composer stays hidden, WS never connects — the page degrades to
 * raw markup). Literal-substring tests cannot catch this class; this suite
 * syntax-checks every script block of RENDER_SHELL_HTML with new Function().
 * Root-cause incident: 2026-08-18 G1 inserted a raw newline inside a string
 * literal (split) — suite was green, shell was dead.
 *
 * Every scan here carries a vacuity canary. A static scanner that stops
 * matching (the shell moves to arrow IIFEs, the <script> extraction regex
 * drifts) passes every assertion downstream of it in silence — the exact way
 * the 2026-08-18 incident stayed green. A scan that examined nothing is a
 * failure, not a pass.
 */
import { describe, expect, test } from "bun:test";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";

/** Every `<script>` body in the shipped shell. */
function scriptBlocks(): string[] {
  return [...RENDER_SHELL_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

/** Comment-stripped source — identifiers inside comments are not references. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

describe("RENDER_SHELL_HTML — every script block must PARSE", () => {
  test("new Function() accepts each <script> body (no SyntaxError)", () => {
    const blocks = scriptBlocks();
    expect(blocks.length, "no <script> block was extracted — the gate is scanning nothing").toBeGreaterThan(0);
    for (const [i, src] of blocks.entries()) {
      let err: unknown = null;
      try {
        new Function(src);
      } catch (e) {
        err = e;
      }
      expect(err, `script block ${i} failed to parse: ${err instanceof Error ? err.message : String(err)}`).toBeNull();
    }
  });

  test("the parse gate actually rejects the 2026-08-18 incident class (raw newline in a string literal)", () => {
    // The mutation the incident shipped: a raw newline inside a single-quoted
    // string. Injecting it into a REAL script block must make new Function()
    // throw. Without this, "every block parses" could be green because the
    // blocks are empty, or because new Function() was handed something it
    // never actually parses. Guards the guard.
    const blocks = scriptBlocks();
    const victim = blocks.find((b) => /'[^'\n]*'/.test(b));
    expect(victim, "no script block contains a single-quoted string to mutate — canary cannot run").toBeDefined();

    const mutated = victim!.replace(/'([^'\n]*)'/, "'$1\n'");
    expect(mutated, "the mutation did not change the source").not.toBe(victim);

    let err: unknown = null;
    try {
      new Function(mutated);
    } catch (e) {
      err = e;
    }
    expect(err, "a raw newline inside a string literal did NOT fail the parse gate — the gate is decorative").not.toBeNull();
  });

  test("no immediately-executed IIFE references a const declared LATER (TDZ)", () => {
    // Incident class #2 (2026-08-18): an observer-wiring IIFE ran before the
    // const element lookups initialized — ReferenceError at boot, whole shell
    // dead, while every syntax check passed. Static scan with a BALANCED
    // reader: for each top-level IIFE (paren/brace balanced — regex spans
    // false-positive across map callbacks), its body must not mention any
    // TOP-LEVEL const (line-start, unindented) declared later in the script.
    let iifesExamined = 0;
    let nameChecks = 0;

    for (const src of scriptBlocks()) {
      const code = stripComments(src);
      // top-level const declarations only (nested function scopes bind their own)
      const decls = new Map<string, number>();
      for (const m of code.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=/gm)) decls.set(m[1]!, m.index ?? 0);
      // balanced IIFE reader: find `(function` starts, walk to their matching
      // close paren, require the immediate-call `()` suffix
      for (let i = code.indexOf("(function"); i !== -1; i = code.indexOf("(function", i + 1)) {
        let depth = 0;
        let j = i;
        for (; j < code.length; j++) {
          if (code[j] === "(") depth++;
          else if (code[j] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        const after = code.slice(j + 1, j + 4);
        if (!after.startsWith("()")) continue; // not an immediate call
        iifesExamined++;
        const body = code.slice(i, j + 1);
        for (const [name, declAt] of decls) {
          nameChecks++;
          if (declAt > i && new RegExp("\\b" + name + "\\b").test(body)) {
            throw new Error(
              "TDZ: IIFE at offset " +
                i +
                " references top-level const '" +
                name +
                "' (declared at " +
                declAt +
                ") before initialization",
            );
          }
        }
      }
    }

    // Vacuity canary: the scan above only proves something if it read something.
    // `(function…)()` going to zero means the shell switched IIFE style (arrow
    // IIFEs, module scope) and this test silently stopped guarding — update the
    // reader, do not delete the assertion.
    expect(iifesExamined, "the TDZ scan found no immediate `(function…)()` IIFE — it is no longer guarding anything").toBeGreaterThan(0);
    expect(nameChecks, "the TDZ scan performed no name checks — no top-level const was declared to check against").toBeGreaterThan(0);
  });
});
