/**
 * verify — stable, repeatable verification of pi-agent's extension loading
 * across source AND deployed-package layouts, from multiple cwds.
 *
 * WHY THIS EXISTS
 *   run-dir/resolve.ts has three modes (source / repo-bundle / deploy-package)
 *   and cwd-coupled bugs that are INVISIBLE when you only test from inside the
 *   artifact or trust the model's `-p` reply. This script codifies the method
 *   that catches them: build + deploy a fresh package, run a probe extension
 *   (pi.getAllTools()) across SOURCE (repo + /tmp) and DEPLOY (foreign cwd +
 *   repo), assert ZERO conflict/cannot-find/failed-to-load and matched>0, and
 *   kill the process the instant the probe fires (no model call — fast/offline).
 *
 * USAGE
 *   bun scripts/verify.ts              # build + deploy + run all scenarios
 *   bun scripts/verify.ts --no-build   # reuse existing dist/pi-agent bundle
 *
 * Exit 0 = all pass; 1 = any failed.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const NO_BUILD = argv.includes("--no-build");

const piAgentDir = dirname(import.meta.dir);
const repoRoot = dirname(dirname(piAgentDir));
const srcCli = join(piAgentDir, "src", "cli.ts");
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

// probe: counts tools whose source path includes $PI_VERIFY_MARKER
const PROBE_TS = `
export default (pi) => {
  pi.on("session_start", () => {
    const tools = pi.getAllTools();
    const marker = process.env.PI_VERIFY_MARKER ?? "";
    let matched = 0;
    for (const t of tools) {
      if (marker && String(t.sourceInfo?.path ?? "").includes(marker)) matched++;
    }
    process.stderr.write("[PROBE] total=" + tools.length + " matched=" + matched + "\\n");
  });
};
`;

interface Scenario { name: string; cmd: string[]; cwd: string; marker: string; }
interface Result { name: string; ok: boolean; total: number | null; matched: number | null; errors: string[]; }

async function runScenario(s: Scenario): Promise<Result> {
  const errors: string[] = [];
  let total: number | null = null;
  let matched: number | null = null;
  const proc = Bun.spawn(s.cmd, {
    cwd: s.cwd,
    env: { ...process.env, PI_VERIFY_MARKER: s.marker },
    stderr: "pipe",
    stdout: "pipe",
  });
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const ERR = /conflict|cannot find|failed to load/i;
  let killed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = line.match(/\[PROBE\] total=(\d+) matched=(\d+)/);
        if (m) {
          total = +m[1]; matched = +m[2];
          try { proc.kill(); } catch { /* */ }
          killed = true;
        } else if (ERR.test(line)) {
          errors.push(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
        }
      }
      if (killed) break;
    }
  } finally { try { proc.kill(); } catch { /* */ } }
  const ok = total !== null && matched !== null && matched > 0 && errors.length === 0 && total >= 7 + matched;
  return { name: s.name, ok, total, matched, errors };
}

async function main() {
  console.log(`${Y("▶ verify pi-agent extension loading")}`);
  if (!NO_BUILD) {
    console.log(`${G("▶")} build bundle`);
    const b = Bun.spawn(["bun", "scripts/build.ts"], { cwd: piAgentDir, stdout: "inherit", stderr: "inherit" });
    if ((await b.exited) !== 0) { console.error(R("✗ build failed")); process.exit(1); }
  }
  const pkgDir = mkdtempSync(join(tmpdir(), "pi-agent-verify-"));
  console.log(`${G("▶")} deploy → ${D(pkgDir)}`);
  const d = Bun.spawn(["bun", "scripts/deploy.ts", pkgDir, "--no-build"], { cwd: piAgentDir, stdout: "pipe", stderr: "inherit" });
  if ((await d.exited) !== 0) { console.error(R("✗ deploy failed")); rmSync(pkgDir, { recursive: true, force: true }); process.exit(1); }
  const pkgPiAgent = join(pkgDir, "pi-agent.js");
  if (!existsSync(pkgPiAgent)) { console.error(R("✗ package missing pi-agent.js")); process.exit(1); }

  const probePath = join(pkgDir, ".verify-probe.ts");
  writeFileSync(probePath, PROBE_TS);

  const scenarios: Scenario[] = [
    { name: "SOURCE from repo",  cmd: ["bun", srcCli, "-e", probePath, "-p", "hi"],     cwd: repoRoot,  marker: join(repoRoot, "bun-apps") },
    { name: "SOURCE from /tmp",  cmd: ["bun", srcCli, "-e", probePath, "-p", "hi"],     cwd: tmpdir(),  marker: join(repoRoot, "bun-apps") },
    { name: "DEPLOY  from /tmp", cmd: ["bun", pkgPiAgent, "-e", probePath, "-p", "hi"], cwd: tmpdir(),  marker: pkgDir },
    { name: "DEPLOY  from repo", cmd: ["bun", pkgPiAgent, "-e", probePath, "-p", "hi"], cwd: repoRoot,  marker: pkgDir },
  ];

  const results: Result[] = [];
  for (const s of scenarios) {
    process.stdout.write(`  ${D("•")} ${s.name.padEnd(20)} … `);
    const r = await runScenario(s);
    results.push(r);
    console.log(r.ok ? G("PASS") : R("FAIL"));
    for (const e of r.errors.slice(0, 3)) console.log(`      ${R(e)}`);
  }
  rmSync(pkgDir, { recursive: true, force: true });

  console.log("");
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`  ${(r.ok ? G("✓") : R("✗"))} ${r.name.padEnd(20)} total=${r.total ?? "?"} matched=${r.matched ?? "?"} stderrErrors=${r.errors.length}`);
  console.log("");
  const ok = passed === results.length;
  console.log(ok ? G(`✓ ${passed}/${results.length} scenarios passed`) : R(`✗ ${passed}/${results.length} scenarios passed`));
  process.exit(ok ? 0 : 1);
}

main();
