import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// test lives at <pkg>/src/cli/__tests__ — up THREE levels to the package root,
// then TWO more (pkg → bun-apps → repo root).
const pkgDir = join(__dirname, "..", "..", "..");  // bun-apps/s2-agent
const repoRoot = join(pkgDir, "..", "..");         // repo root
const dec = new TextDecoder();

interface Baseline {
  toolCountFloor: number;
  expectedErrorSources: string[];
  sourceMinimum: string[];
  expectedContractFailures?: string[];
}
const baseline: Baseline = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/boot-smoke.baseline.json"), "utf8"),
);

/** Build a gitignored workspace dist artifact only if its marker is absent.
 * CI's setup-env already builds both; this makes local `bun test` work without
 * a manual prebuild. Idempotent + fast (~3 s on a cold run). */
function buildIfMissing(pkg: string, script: string, marker: string): void {
  if (existsSync(join(repoRoot, "bun-apps", pkg, marker))) return;
  const r = Bun.spawnSync({
    cmd: [process.execPath, "run", script],
    cwd: join(repoRoot, "bun-apps", pkg),
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`prebuild failed for ${pkg} (${script}): ${dec.decode(r.stderr)}`);
  }
}

/** Spawn the CLI in source mode and return {exitCode, json, stderr}. */
function runCanary(): { exitCode: number | null; json: unknown; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "src/cli.ts", "cli", "tools-metrics", "--schema-cost", "--json"],
    cwd: pkgDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = dec.decode(proc.stdout);
  let json: unknown = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* the exit-code / JSON assertion below surfaces the real failure */
  }
  return { exitCode: proc.exitCode, json, stderr: dec.decode(proc.stderr) };
}

describe("boot-smoke canary", () => {
  // ONE shared canary boot for the whole describe: each test used to spawn its
  // own identical `tools-metrics` boot, paying the full extension load +
  // hermes startup sync twice (~4.6 s per boot, measured 2026-08-22) for zero
  // extra coverage — both tests assert on the SAME run's output. hermes stays
  // ON here (unlike the e2e/_helpers.ts harness): the baseline's sourceMinimum
  // includes hermes-memory's tools.
  let canary: ReturnType<typeof runCanary>;

  beforeAll(() => {
    // s2-agent-ext-ultracode is src-entry since the 2026-08-15 src-entry migration
    // (ticket 04): package root resolves to src/index.ts, nothing to build.
    // (KC now imports obsidian.ts directly post-#558 — no obsidian bundle build
    // needed either.)
    buildIfMissing("s2-agent-ext-subagent", "build", "dist/index.js");
    canary = runCanary();
    // Trailing timeout (cast: pinned bun-types lack the overload; runtime
    // honors it) — the hook now CARRIES the real CLI boot, so it needs the
    // same 30s hang bound the tests used to declare individually.
  }, 30_000 as never);

  // Trailing timeouts (cast: pinned bun-types lack the overload; runtime
  // honors it): the suite spawns a REAL CLI boot (in beforeAll), and
  // hermes-memory's startup sync alone costs ~3.5s (perf.jsonl 2026-08-22) —
  // measured boots ~4.6s, comfortably above bun's 5s default. 30s bounds a hang.
  test("CLI boots in source mode and the canary command exits 0 with valid JSON", () => {
    const { exitCode, json, stderr } = canary;
    expect(exitCode, `canary exited non-zero.\nstderr:\n${stderr}`).toBe(0);
    expect(json, `stdout was not valid JSON; stderr:\n${stderr}`).not.toBeNull();
    const obj = json as Record<string, unknown>;
    for (const key of ["toolsRanked", "errors", "builtinCount", "extensionCount", "totalTokens"]) {
      expect(obj).toHaveProperty(key);
    }
  }, 30_000 as never);

  test("no new factory errors, tool-count at floor, 0 tool-name conflicts, expected sources present", () => {
    const { exitCode, json, stderr } = canary;
    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    const obj = json as {
      toolsRanked: Array<{ name: string; source: string; hasExecute?: boolean; schemaValid?: boolean }>;
      errors?: Array<{ source: string; error: string }>;
    };

    // 1. errors == baseline (compare error SOURCES, order-independent — error
    //    text is not stable, source is). A NEW source appearing here = red.
    const errSources = [...new Set((obj.errors ?? []).map((e) => e.source))].sort();
    expect(errSources).toEqual([...baseline.expectedErrorSources].sort());

    // 2. tool count >= floor (a factory silently wiring fewer tools = red)
    expect(obj.toolsRanked.length).toBeGreaterThanOrEqual(baseline.toolCountFloor);

    // 3. 0 duplicate tool names = the 0-conflict contract (mirrors deploy --verify)
    const names = obj.toolsRanked.map((t) => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(new Set(names).size, `duplicate tool-name conflicts: ${[...new Set(dupes)].join(", ")}`).toBe(names.length);

    // 4. source ⊇ minimum set (a tool-registering extension disappearing = red)
    const sources = new Set(obj.toolsRanked.map((t) => t.source));
    for (const s of baseline.sourceMinimum) {
      expect(sources, `missing expected extension source: ${s}`).toContain(s);
    }

    // 5. contract: every tool has an `execute` handler + a valid constructible
    //    schema. Presence guard first — if the capture stops reporting these,
    //    fail loudly instead of passing vacuously on `undefined`.
    const flagged = obj.toolsRanked.filter(
      (t) => typeof t.hasExecute === "boolean" && typeof t.schemaValid === "boolean",
    );
    expect(flagged.length, "capture did not report contract flags (hasExecute/schemaValid) on every tool").toBe(obj.toolsRanked.length);
    const noExec = obj.toolsRanked.filter((t) => t.hasExecute === false).map((t) => `${t.name} (missing execute)`);
    const badSchema = obj.toolsRanked.filter((t) => t.schemaValid === false).map((t) => `${t.name} (invalid schema)`);
    const contractFails = [...noExec, ...badSchema].sort();
    expect(contractFails, `unexpected contract failures: ${contractFails.join(", ")}`).toEqual(
      [...(baseline.expectedContractFailures ?? [])].sort(),
    );
  }, 30_000 as never);
});
