/**
 * JSONC reader for the structural guards that read tsconfig.json as data.
 *
 * tsconfig.json is JSONC by specification — tsc accepts `//` and block comments
 * and trailing commas — so any gate that reaches for `JSON.parse` on one is a
 * SyntaxError waiting for the first tsconfig that documents itself. `dep-guard`
 * was exactly that: one commented tsconfig threw inside its `types`-edge read
 * and took four unrelated assertions down with it.
 *
 * NOT a `.test.ts` on purpose: importing a test file from another test file
 * re-registers its whole suite. Shared machinery lives in a plain module.
 *
 * SCANNED CHARACTER BY CHARACTER, not stripped with a regex. The value these
 * gates read about most is `"extensions/ ** /*.ts"` (written without the spaces),
 * which contains a literal block-comment pair. A naive `/\/\*[\s\S]*?\*\//g`
 * deletes the middle of it and silently turns the pattern into `"extensions*.ts"`
 * — every correctly configured package then reads as uncovered. That is not
 * hypothetical: it is what the first draft of the extension-entry guard did,
 * reporting 33 failures of which 23 were phantom.
 */
import { readFileSync } from "node:fs";

/** Strip JSONC comments and trailing commas, respecting string literals. */
export function stripJsonc(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === '"') {
      const start = i++;
      while (i < raw.length && raw[i] !== '"') i += raw[i] === "\\" ? 2 : 1;
      out += raw.slice(start, ++i);
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Parse a JSONC file (tsconfig.json and friends) into a plain object. */
export function readJsonc(path: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as Record<string, unknown>;
}
