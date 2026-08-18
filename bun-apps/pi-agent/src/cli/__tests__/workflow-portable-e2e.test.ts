import { describe, it, expect } from "bun:test";
import { statSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// dist/pi-agent/pi-agent, resolved from the `bun test` cwd (bun-apps/pi-agent).
// The CLI has no binary of its own any more — it ships inside pi-agent's exe.
const EXE = join(process.cwd(), "..", "..", "dist", "pi-agent", "pi-agent");

/**
 * End-to-end portable-binary proof (ticket 05). Runs the COMPILED exe from a
 * FOREIGN cwd (mkdtemp under /tmp — no .pi/workflows or bun-apps ancestry, so
 * findRepoRoot returns undefined) and asserts name-resolution via the new
 * <cwd>/workflows tier works. Skipped when the exe isn't built — run
 * `bun run --cwd bun-apps/pi-agent build:exe` first.
 */
/**
 * The guard was `!existsSync(EXE)`, which is also true for a DIRECTORY. A
 * `--snapshot` deploy writes `dist/pi-agent/pi-agent/` (the copied package
 * dir), so after one the suite stopped skipping and spawned a directory —
 * 2 failures that had nothing to do with the code under test. Require an
 * executable FILE, which is the thing these tests actually need.
 */
const EXE_READY = (() => {
	try {
		const st = statSync(EXE);
		return st.isFile() && (st.mode & 0o111) !== 0;
	} catch {
		return false;
	}
})();

describe.skipIf(!EXE_READY)("compiled pi-agent: portable workflow-pack run", () => {
  function makePack(dir: string, desc: string): void {
    mkdirSync(join(dir, "workflows", "echo"), { recursive: true });
    writeFileSync(join(dir, "workflows", "echo", "manifest.json"), JSON.stringify({ name: "echo", description: desc, entry: "index.js" }));
    writeFileSync(join(dir, "workflows", "echo", "index.js"), `export const meta = { name: "echo", description: "${desc}" };\nreturn { tier: "${desc}" };\n`);
  }

  it("resolves + runs a pack BY NAME from a foreign cwd via <cwd>/workflows (source cwd-workflows)", async () => {
    const foreign = mkdtempSync(join(tmpdir(), "pi-portable-"));
    makePack(foreign, "portable");
    const proc = Bun.spawn([EXE, "cli", "workflow", "run", "echo", "--dry-run"], { cwd: foreign, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(code).toBe(0);
    expect(out).toContain("cwd-workflows"); // the receipt prints `(source: cwd-workflows)`
    expect(err).toBe("");
  });

  it("runs a pack via absolute path from a foreign cwd (baseline, source path)", async () => {
    const foreign = mkdtempSync(join(tmpdir(), "pi-portable-abs-"));
    // NOTE: makePack lays the pack at <dir>/workflows/echo/ (so test 1 can resolve
    // it BY NAME). The absolute path that points AT the pack dir is therefore
    // <packDir>/workflows/echo — the literal-path branch needs manifest.json at
    // the root of the passed dir. (Brief passed join(packDir); fixed to point at
    // the actual pack — see task-3-report.md §Deviation.)
    const packDir = mkdtempSync(join(tmpdir(), "pi-portable-pack-"));
    makePack(packDir, "abspath");
    const proc = Bun.spawn([EXE, "cli", "workflow", "run", join(packDir, "workflows", "echo"), "--dry-run"], { cwd: foreign, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(code).toBe(0);
    expect(out).toContain("source: path");
    expect(err).toBe("");
  });
});
