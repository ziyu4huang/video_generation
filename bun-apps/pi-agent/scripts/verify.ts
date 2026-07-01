/**
 * verify — stable, repeatable verification of pi-agent's extension loading.
 *
 * WHY THIS EXISTS
 *   The deploy/source extension-injection logic (src/deploy-mode.ts) has bitten
 *   us repeatedly with cwd-coupled bugs that are INVISIBLE when you only test
 *   from inside the package or trust the model's self-report in `-p` mode. This
 *   script codifies the verification methodology that actually catches them:
 *
 *     • run from a FOREIGN cwd (not just from inside the artifact),
 *     • run against a REAL installed repo declaring the same extensions,
 *     • measure REAL tool registration via a probe extension (pi.getAllTools()),
 *       NOT the model's reply,
 *     • assert ZERO conflict / "cannot find" / "failed to load" lines on stderr.
 *
 *   It builds + deploys a fresh package, then exercises both modes across
 *   multiple cwds, parsing a structured [PROBE] line and killing the process
 *   the instant the probe fires — so it needs NO model call (fast, offline).
 *
 * WHAT IT CHECKS (per scenario)
 *   • stderr has ZERO conflict / cannot-find / failed-to-load lines, AND
 *   • the probe reports matched > 0 (extensions actually loaded from the
 *     intended source: the workspace bun-apps/ for source, the package's
 *     packages/ for deploy), AND
 *   • total >= 7 builtins + matched (additive layers may add more in source).
 *
 * USAGE
 *   bun scripts/verify.ts              # build + deploy + run all scenarios
 *   bun scripts/verify.ts --no-build   # reuse existing dist/pi-agent bundle
 *   bun scripts/verify.ts --keep       # keep the temp package dir (debug)
 *
 * Exit code 0 = all scenarios pass; 1 = any failed.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const NO_BUILD = argv.includes("--no-build");
const KEEP = argv.includes("--keep");

const piAgentDir = dirname(import.meta.dir); // bun-apps/pi-agent
const repoRoot = dirname(dirname(piAgentDir)); // workspace root
const srcCli = join(piAgentDir, "src", "cli.ts");
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ── the probe: counts tools whose source path includes $PI_VERIFY_MARKER ────
// Writes one structured line to stderr on session_start: [PROBE] total=N matched=M
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

interface Scenario {
  name: string;
  cmd: string[];
  cwd: string;
  marker: string; // substring that identifies "loaded from intended source"
}
interface ScenarioResult {
  name: string;
  ok: boolean;
  total: number | null;
  matched: number | null;
  errors: string[];
  detail: string;
}

/** Run a scenario: spawn pi, stream stderr, kill once [PROBE] fires. */
async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const errors: string[] = [];
  let total: number | null = null;
  let matched: number | null = null;
  const proc = Bun.spawn(s.cmd, {
    cwd: s.cwd,
    env: { ...process.env, PI_VERIFY_MARKER: s.marker, BUN_PI_SKIP_PREFLIGHT: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const ERROR_RE = /conflict|cannot find|failed to load/i;
  let killed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // scan complete lines
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = line.match(/\[PROBE\] total=(\d+) matched=(\d+)/);
        if (m) {
          total = +m[1];
          matched = +m[2];
          // probe fired — kill before any model call
          try { proc.kill(); } catch { /* already exiting */ }
          killed = true;
        } else if (ERROR_RE.test(line)) {
          errors.push(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
        }
      }
      if (killed) break;
    }
  } finally {
    try { proc.kill(); } catch { /* noop */ }
  }

  const ok = total !== null && matched !== null && errors.length === 0 && matched > 0 && total >= 7 + matched;
  return {
    name: s.name,
    ok,
    total,
    matched,
    errors,
    detail: `total=${total ?? "?"} matched=${matched ?? "?"} stderrErrors=${errors.length}`,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${Y("▶ verify pi-agent extension loading")}`);

  // 1. build
  if (!NO_BUILD) {
    console.log(`${G("▶")} build bundle`);
    const b = Bun.spawn(["bun", "scripts/build.ts"], { cwd: piAgentDir, stdout: "inherit", stderr: "inherit" });
    if ((await b.exited) !== 0) { console.error(R("✗ build failed")); process.exit(1); }
  }

  // 2. deploy to a temp dir
  const pkgDir = mkdtempSync(join(tmpdir(), "pi-agent-verify-"));
  console.log(`${G("▶")} deploy → ${D(pkgDir)}`);
  const d = Bun.spawn(["bun", "scripts/deploy.ts", pkgDir, "--no-build"], {
    cwd: piAgentDir, stdout: "pipe", stderr: "inherit",
  });
  if ((await d.exited) !== 0) { console.error(R("✗ deploy failed")); clean(pkgDir); process.exit(1); }
  const pkgPiAgent = join(pkgDir, "pi-agent.js");
  if (!existsSync(pkgPiAgent)) { console.error(R("✗ package missing pi-agent.js")); clean(pkgDir); process.exit(1); }

  // 3. write probe to temp
  const probePath = join(pkgDir, "..verify-probe.ts");
  writeFileSync(probePath, PROBE_TS);

  // 4. scenarios
  const scenarios: Scenario[] = [
    { name: "SOURCE from repo",       cmd: ["bun", srcCli, "-e", probePath, "-p", "hi"], cwd: repoRoot, marker: join(repoRoot, "bun-apps") },
    { name: "SOURCE from /tmp",       cmd: ["bun", srcCli, "-e", probePath, "-p", "hi"], cwd: tmpdir(),  marker: join(repoRoot, "bun-apps") },
    { name: "DEPLOY  from /tmp",      cmd: ["bun", pkgPiAgent, "-e", probePath, "-p", "hi"], cwd: tmpdir(),  marker: pkgDir },
    { name: "DEPLOY  from repo",      cmd: ["bun", pkgPiAgent, "-e", probePath, "-p", "hi"], cwd: repoRoot,  marker: pkgDir },
  ];

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    process.stdout.write(`  ${D("•")} ${s.name.padEnd(22)} … `);
    const r = await runScenario(s);
    results.push(r);
    console.log(r.ok ? G("PASS") : R("FAIL"));
    if (r.errors.length) for (const e of r.errors.slice(0, 3)) console.log(`      ${R(e)}`);
  }

  clean(pkgDir);
  try { rmSync(probePath, { force: true }); } catch { /* noop */ }

  // 5. report
  console.log("");
  const passed = results.filter((r) => r.ok).length;
  const allOk = passed === results.length;
  for (const r of results) {
    console.log(`  ${(r.ok ? G("✓") : R("✗"))} ${r.name.padEnd(22)} ${r.detail}`);
  }
  console.log("");
  console.log(allOk ? G(`✓ ${passed}/${results.length} scenarios passed`) : R(`✗ ${passed}/${results.length} scenarios passed`));
  process.exit(allOk ? 0 : 1);

  function clean(dir: string) {
    if (KEEP) { console.log(`${Y("·")} kept package dir (--keep): ${dir}`); return; }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

main();
