import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// test lives in <pkg>/src/__tests__ — up TWO levels to the package root, then
// TWO more (pkg → bun-apps → repo root).
const pkgDir = join(__dirname, "..", "..");        // bun-apps/pi-agent-cli
const repoRoot = join(pkgDir, "..", "..");         // repo root
const dec = new TextDecoder();

/** Build a gitignored workspace dist artifact only if its marker is absent.
 * CI's setup-env already builds both; this makes local `bun test` work without
 * a manual prebuild. Idempotent + fast (~3 s on a cold run). */
function buildIfMissing(pkg: string, script: string, marker: string): void {
  if (existsSync(join(repoRoot, "bun-apps", pkg, marker))) return;
  const r = Bun.spawnSync({
    cmd: ["bun", "run", script],
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
    cmd: ["bun", "src/cli.ts", "tools-metrics", "--schema-cost", "--json"],
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
  beforeAll(() => {
    buildIfMissing("pi-agent-ext-workflow", "build", "dist/index.js");
    buildIfMissing("pi-agent-ext-obsidian", "build:bundle", "dist/obsidian.bundle.js");
  });

  test("CLI boots in source mode and the canary command exits 0 with valid JSON", () => {
    const { exitCode, json, stderr } = runCanary();
    expect(exitCode, `canary exited non-zero.\nstderr:\n${stderr}`).toBe(0);
    expect(json, `stdout was not valid JSON; stderr:\n${stderr}`).not.toBeNull();
    const obj = json as Record<string, unknown>;
    for (const key of ["toolsRanked", "errors", "builtinCount", "extensionCount", "totalTokens"]) {
      expect(obj).toHaveProperty(key);
    }
  });
});
