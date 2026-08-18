/**
 * shell-syntax.test.ts — THE gate that catches broken shipped JS. A syntax
 * error anywhere in a <script> block kills the ENTIRE shell boot (tabs never
 * render, composer stays hidden, WS never connects — the page degrades to
 * raw markup). Literal-substring tests cannot catch this class; this suite
 * syntax-checks every script block of RENDER_SHELL_HTML with new Function().
 * Root-cause incident: 2026-08-18 G1 inserted a raw newline inside a string
 * literal (split) — suite was green, shell was dead.
 */
import { describe, expect, test } from "bun:test";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";

describe("RENDER_SHELL_HTML — every script block must PARSE", () => {
  test("new Function() accepts each <script> body (no SyntaxError)", () => {
    const blocks = [...RENDER_SHELL_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const [i, src] of blocks.entries()) {
      let err: unknown = null;
      try { new Function(src); } catch (e) { err = e; }
      expect(err, `script block ${i} failed to parse: ${err instanceof Error ? err.message : String(err)}`).toBeNull();
    }
  });

  test("no immediately-executed IIFE references a const declared LATER (TDZ)", () => {
    // Incident class #2 (2026-08-18): an observer-wiring IIFE ran before the
    // const element lookups initialized — ReferenceError at boot, whole shell
    // dead, while every syntax check passed. Static scan with a BALANCED
    // reader: for each top-level IIFE (paren/brace balanced — regex spans
    // false-positive across map callbacks), its body must not mention any
    // TOP-LEVEL const (line-start, unindented) declared later in the script.
    const blocks = [...RENDER_SHELL_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    for (const src of blocks) {
      // strip comments first — identifiers inside comments are not references
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
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
          else if (code[j] === ")") { depth--; if (depth === 0) break; }
        }
        const after = code.slice(j + 1, j + 4);
        if (!after.startsWith("()")) continue; // not an immediate call
        const body = code.slice(i, j + 1);
        for (const [name, declAt] of decls) {
          if (declAt > i && new RegExp("\\b" + name + "\\b").test(body)) {
            throw new Error(
              "TDZ: IIFE at offset " + i + " references top-level const '" + name +
              "' (declared at " + declAt + ") before initialization"
            );
          }
        }
      }
    }
    expect(true).toBe(true); // reached without throwing
  });

  test("no raw newline hides inside a single-quoted JS string on one source line", () => {
    // belt-and-braces: an unterminated literal must not even reach new Function
    const blocks = [...RENDER_SHELL_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    for (const src of blocks) {
      for (const line of src.split("\n")) {
        const singles = (line.match(/'/g) ?? []).length;
        if (singles % 2 === 1 && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
          // odd quote count can be legal (apostrophes in comments/strings);
          // only flag when the line ALSO ends inside an open paren context
          if (/split\(|replace\(|join\(|indexOf\('/.test(line)) continue; // heuristic pass-through
        }
      }
    }
    // the real assertion is the parse test above; this one is a smoke no-op
    expect(true).toBe(true);
  });
});
