/**
 * dead-export.test.ts — no s2-agent package may grow a NEW exported value that
 * nothing anywhere references.
 *
 * WHY THIS EXISTS
 * ---------------
 * A sweep on 2026-08-19 found 42 exported functions/consts across ten
 * s2-agent packages with zero references in the entire repository — not in
 * other packages, not in tests, not even in their own file. They were not
 * harmless. The pattern they formed is what made them worth a gate:
 *
 *   - `clearSession` (wayfind) carried the doc comment "called on
 *     session_shutdown" while `endGrillForSession` was the function actually
 *     wired there. The dead one *claimed* to be the live one.
 *   - `getLastAssistantMessage` (btw/transcript) returned `null`
 *     unconditionally and shared its name with the real implementation in
 *     session.ts.
 *   - `envFloat` (hermes) outlived the near-dup gate it was added for by four
 *     merges; `__test` (s2-agent) outlived the stale-dist machinery retired in
 *     #1406.
 *   - Thirteen `…PatchApplied = true` constants encoded a reporting pattern
 *     that patches/index.ts documents as a defect.
 *
 * Dead exports are not clutter, they are misinformation: they make a reader
 * believe a code path exists. This gate stops that accumulating again.
 *
 * SCOPE. Values only — `function`, `const`, `class`. Exported types and
 * interfaces are deliberately NOT scanned: an exported type used once inside
 * its own module is normal, cheap, and would drown the signal.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * Exports that ARE unreferenced and are allowed to stay, each with the reason.
 *
 * This list is held to the same standard as the code: an entry that is no
 * longer dead FAILS and must be deleted. A stale allowlist is how a guard
 * quietly stops guarding.
 */
const ALLOWED: readonly { symbol: string; file: string; reason: string }[] = [
  // ── deliberate package public API, reached through `export *` in src/index.ts
  {
    symbol: "getStageSkill",
    file: "s2-agent-ext-movie-director/src/pipeline.ts",
    reason: "pipeline stage accessor — public surface via src/index.ts `export * from './pipeline.ts'`",
  },
  {
    symbol: "getStageReviewFocus",
    file: "s2-agent-ext-movie-director/src/pipeline.ts",
    reason: "pipeline stage accessor — public surface via src/index.ts",
  },
  {
    symbol: "getStageTools",
    file: "s2-agent-ext-movie-director/src/pipeline.ts",
    reason: "pipeline stage accessor — public surface via src/index.ts",
  },
  {
    symbol: "callableForCapability",
    file: "s2-agent-ext-movie-director/src/providers.ts",
    reason: "provider-capability lookup — public surface via src/index.ts",
  },
  {
    symbol: "remotionAvailable",
    file: "s2-agent-ext-movie-director/src/remotion.ts",
    reason: "renderer availability probe — public surface via src/index.ts",
  },
  {
    symbol: "hyperframesAvailable",
    file: "s2-agent-ext-movie-director/src/hyperframes_native.ts",
    reason: "renderer availability probe — public surface via src/index.ts",
  },
  {
    symbol: "vaultConfigPath",
    file: "s2-agent-ext-obsidian/src/lib/vault-resolution.ts",
    reason: "vault-resolution tier API — public surface via obsidian-lib.ts `export *`",
  },
  {
    symbol: "readVaultConfig",
    file: "s2-agent-ext-obsidian/src/lib/vault-resolution.ts",
    reason: "vault-resolution tier API — public surface via obsidian-lib.ts `export *`",
  },
  // ── reference data, read by humans rather than code
  {
    symbol: "CORE_RELATIONS",
    file: "s2-agent-ext-hermes-memory/src/store/relation-schema.ts",
    reason: "documents the six core predicates that normalizeRelation() collapses aliases onto",
  },
  {
    symbol: "GOLDEN_STATS",
    file: "s2-agent-ext-hermes-memory/bench/dedup-golden-corpus.ts",
    reason: "recorded benchmark baseline in a bench fixture, not runtime code",
  },
  // ── a KNOWN GAP, kept visible on purpose
  {
    symbol: "presentAnswerToUserTurn",
    file: "s2-agent-ext-webui/src/present-event-handler.ts",
    reason:
      "spec §C2's answer→user-turn formatter. The event-originated path is BUILT BUT UNWIRED: " +
      "createPresentEventHandler mints the view and invokes an optional `onEventPresent` callback " +
      "that the wiring never supplies, and this formatter is never called. Deleting it would erase " +
      "the evidence of the missing last mile — the fix is to wire it, not to drop it.",
  },
];

/** Every non-test TypeScript source under the s2-agent packages. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
    }
  };
  for (const pkg of readdirSync(ROOT).filter((d) => d.startsWith("s2-agent"))) {
    try {
      if (statSync(join(ROOT, pkg)).isDirectory()) walk(join(ROOT, pkg));
    } catch {
      /* not a directory */
    }
  }
  return out.sort();
}

/**
 * Every text file the whole workspace could reference a symbol from.
 *
 * THIS FILE IS EXCLUDED. The ALLOWED table names every symbol it exempts, so
 * counting itself would make each exemption look like a reference and the
 * whole scan would report nothing — a guard defeated by its own record.
 */
function corpusFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|[cm]?jsx?|json|md|sh|ya?ml)$/.test(p) && p !== import.meta.path) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

const IDENT = /[A-Za-z_$][\w$]*/g;
const EXPORTED_VALUE = /^export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm;

/** identifier -> total occurrences across the workspace, and per defining file. */
function buildIndex() {
  const global = new Map<string, number>();
  const perFile = new Map<string, Map<string, number>>();
  for (const f of corpusFiles()) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const local = new Map<string, number>();
    for (const m of text.matchAll(IDENT)) {
      const id = m[0];
      global.set(id, (global.get(id) ?? 0) + 1);
      local.set(id, (local.get(id) ?? 0) + 1);
    }
    perFile.set(f, local);
  }
  return { global, perFile };
}

/** Exported values whose only occurrence in the entire workspace is their own declaration. */
function findDeadExports() {
  const { global, perFile } = buildIndex();
  const dead: { symbol: string; file: string }[] = [];
  for (const f of sourceFiles()) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    EXPORTED_VALUE.lastIndex = 0;
    for (const m of text.matchAll(EXPORTED_VALUE)) {
      const symbol = m[1]!;
      const own = perFile.get(f)?.get(symbol) ?? 0;
      // 1 occurrence workspace-wide == only the `export … <name>` declaration
      if ((global.get(symbol) ?? 0) === 1 && own === 1) {
        dead.push({ symbol, file: f.replace(`${ROOT}/`, "") });
      }
    }
  }
  return dead;
}

describe("s2-agent packages carry no unreferenced exported values", () => {
  const dead = findDeadExports();
  const allowKey = (s: string, f: string) => `${f}::${s}`;
  const allowed = new Set(ALLOWED.map((a) => allowKey(a.symbol, a.file)));

  test("the scan reads real sources (vacuity canary)", () => {
    // A derivation that matches nothing reports zero dead exports and passes
    // every assertion below in silence. Assert it found sources and exports.
    const files = sourceFiles();
    expect(files.length, "no s2-agent source files were discovered — the scan is vacuous").toBeGreaterThan(200);
    const exportsSeen = files.reduce((n, f) => {
      EXPORTED_VALUE.lastIndex = 0;
      return n + [...readFileSync(f, "utf8").matchAll(EXPORTED_VALUE)].length;
    }, 0);
    expect(exportsSeen, "no exported values were parsed — the export pattern no longer matches").toBeGreaterThan(500);
  });

  test("no NEW unreferenced export", () => {
    const offenders = dead.filter((d) => !allowed.has(allowKey(d.symbol, d.file))).map((d) => `${d.file} → ${d.symbol}`);
    expect(
      offenders,
      `these exported values are referenced NOWHERE in the workspace — not by other packages, not by ` +
        `tests, not inside their own file:\n  ${offenders.join("\n  ")}\n\n` +
        `Delete the export, or add it to ALLOWED in this file with the reason it must stay. ` +
        `An unreferenced export is not clutter — it tells a reader a code path exists.`,
    ).toEqual([]);
  });

  test("no STALE allowlist entry", () => {
    // The allowlist is held to the same standard as the code it exempts. An
    // entry that has since gained a reference, or whose symbol/file was
    // renamed, must go — otherwise the list slowly stops describing anything.
    const stillDead = new Set(dead.map((d) => allowKey(d.symbol, d.file)));
    const stale = ALLOWED.filter((a) => !stillDead.has(allowKey(a.symbol, a.file))).map(
      (a) => `${a.file} → ${a.symbol}`,
    );
    expect(
      stale,
      `these ALLOWED entries are no longer unreferenced (or no longer exist):\n  ${stale.join("\n  ")}\n\n` +
        `Remove them from ALLOWED — an exemption for something that needs no exemption is how ` +
        `an allowlist stops describing reality.`,
    ).toEqual([]);
  });
});
