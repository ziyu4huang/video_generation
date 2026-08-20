import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The browser-DOWNLOAD guard (effort archify-view-pptx-bun, ticket 12).
 *
 * ## What this actually guards, and what it deliberately does not
 *
 * Bun 1.4 runs Playwright natively (`connectOverCDP()`, `playwright test`,
 * `--ui`), so "it is not pure Bun" is NOT a reason to ban Playwright any more,
 * and this guard does not pretend otherwise.
 *
 * What it prevents is narrower and concrete: silently re-adding a package that
 * **bundles its own browser download** into these two packages, which is what
 * drags back a ~300 MB install step and, with it, the CI skip-gates that made
 * the old mermaid paint-check dead for months.
 *
 * `playwright-core` and `puppeteer-core` are therefore **deliberately allowed**.
 * They ship WITHOUT browsers and drive an already-installed Chrome/Chromium/Edge
 * over CDP — no download, no skip-gate. `s2-agent-ext-power-tool` in this repo
 * uses `playwright-core` for exactly that reason.
 *
 * Neither package needs a browser today: PPTX export builds real shapes from
 * parsed SVG, and the two tests that genuinely need a rendering engine
 * (`arc-reference`, `architecture-mermaid`) use `Bun.WebView` — system WebKit on
 * macOS, nothing to install. Prefer that when a rendering engine is all you
 * need; reach for `playwright-core` when you need real browser automation.
 *
 * **Scope**: these two packages only. `s2-agent-ext-power-tool` and
 * `gui-movie-director` are out of scope and untouched.
 */
const BANNED = ["playwright", "@playwright/test", "puppeteer"];
/** Explicitly permitted: bring-your-own-browser clients (no download). */
const ALLOWED = ["playwright-core", "puppeteer-core", "@playwright/cli"];
const PKG_ROOT = join(import.meta.dir, "..");
const WEBUI_ROOT = join(PKG_ROOT, "..", "s2-agent-ext-webui");
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const SOURCE_DIRS = ["lib", "scripts", "extensions", "__tests__", "src", "tests"];

function manifestOf(root: string): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

/**
 * THIS file is excluded from its own scan. It necessarily contains literal
 * `from "playwright"` strings — both the banned list and the proof-it-can-fail
 * case below — and a self-referential scan would flag the guard as the
 * violation it exists to detect.
 */
const SELF = import.meta.path;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(e) && p !== SELF) out.push(p);
    }
  };
  for (const d of SOURCE_DIRS) walk(join(root, d));
  return out;
}

for (const [name, root] of [
  ["s2-agent-ext-archify", PKG_ROOT],
  ["s2-agent-ext-webui", WEBUI_ROOT],
] as const) {
  describe(`${name} declares no browser dependency`, () => {
    const manifest = manifestOf(root);

    for (const field of DEP_FIELDS) {
      test(`${field} declares no browser-bundling package`, () => {
        const declared = Object.keys(manifest[field] ?? {});
        expect(declared.filter((d) => BANNED.includes(d))).toEqual([]);
      });
    }

    test("no source file imports one either", () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(root)) {
        const src = readFileSync(file, "utf8");
        for (const dep of BANNED) {
          // Match real module specifiers only — prose in a comment explaining
          // why the dependency is GONE must not trip the guard.
          const re = new RegExp(`(?:from|import|require\\()\\s*["'\`]${dep.replace("/", "\\/")}(?:/[^"'\`]*)?["'\`]`);
          if (re.test(src)) offenders.push(`${file.slice(root.length + 1)} -> ${dep}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
}

describe("the guard can actually fail", () => {
  test("it would catch a real import of a browser-bundling package", () => {
    const re = new RegExp(`(?:from|import|require\\()\\s*["'\`]playwright(?:/[^"'\`]*)?["'\`]`);
    expect(re.test(`import { chromium } from "playwright";`)).toBe(true);
    expect(re.test(`const { chromium } = require("playwright");`)).toBe(true);
    // ...and would NOT trip on prose about its removal.
    expect(re.test(`// the previous implementation launched Playwright chromium`)).toBe(false);
  });

  test("the bring-your-own-browser clients are NOT banned", () => {
    // Bun 1.4 drives an installed Chrome through playwright-core over CDP with
    // nothing to download. Banning that would be cargo-culting the old
    // pure-Bun argument past the point where it stopped being true.
    for (const allowed of ALLOWED) expect(BANNED).not.toContain(allowed);
  });
});
