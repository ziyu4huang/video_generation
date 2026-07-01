/**
 * check-flags.ts — drift guard. Mirrors the GUI `check:schema` discipline:
 * assert every flag `flux2 <cmd> --help` declares is either modeled in
 * src/commands.ts or explicitly allow-listed here. Run after editing
 * commands.ts or after a flux2 CLI change.
 *
 *   bun scripts/check-flags.ts
 *
 * Also asserts every command name in commands.ts exists in `flux2 --help`,
 * so renamed/removed subcommands surface immediately. Exits non-zero on drift.
 */
import { COMMANDS, modeledFlags } from "../src/commands.ts";
import { ensureBinary, resolveRepoRoot } from "../src/binary.ts";
import { invokeFlux2 } from "../src/invoke.ts";

// Flags flux2 emits that we deliberately do NOT model (builtins / globals we
// inject ourselves / diagnostic-only). Add here with a reason.
const ALLOW_SKIP: Record<string, string[]> = {
  // --models-root is injected by the tool's globals; --version/-h are builtins.
  "*": ["--models-root", "--version", "--help", "-h"],
  // t2i also exposes --no-manifest / --no-run-json (OutputOptions). The tool
  // parses the .manifest.json sidecar, so we deliberately do NOT model these —
  // disabling sidecars would break structured result parsing.
  t2i: ["--no-manifest", "--no-run-json"],
};

interface Report {
  command: string;
  missing: string[]; // CLI declares, we don't model & not allow-listed
  unknownCmd: boolean;
}

function parseHelpFlags(stdout: string): string[] {
  const flags = new Set<string>();
  for (const line of stdout.split("\n")) {
    // Match "  --flag <meta>" or "  --flag" (boolean) or "  -h, --help".
    const m = line.match(/^\s+(-[\w-]+(?:,\s*)?)?(--[\w-]+)/);
    if (m && m[2]) flags.add(m[2]);
  }
  return [...flags];
}

async function main() {
  const bin = await ensureBinary();
  const repoRoot = resolveRepoRoot();

  // 1. Verify our command names exist in flux2 --help.
  const top = await invokeFlux2({ bin, args: ["--help"], cwd: repoRoot });
  if (top.exitCode !== 0) {
    console.error(`✗ flux2 --help failed (exit ${top.exitCode})\n${top.stderr}`);
    process.exit(1);
  }
  const declaredSubcommands = new Set<string>();
  for (const line of top.stdout.split("\n")) {
    const m = line.match(/^\s{2,}([\w-]+)\s{2,}/);
    if (m) declaredSubcommands.add(m[1]);
  }

  const reports: Report[] = [];
  let drift = false;

  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (!declaredSubcommands.has(name)) {
      reports.push({ command: name, missing: [], unknownCmd: true });
      drift = true;
      continue;
    }
    const help = await invokeFlux2({ bin, args: [name, "--help"], cwd: repoRoot });
    if (help.exitCode !== 0) {
      console.error(`✗ flux2 ${name} --help failed (exit ${help.exitCode})\n${help.stderr}`);
      drift = true;
      continue;
    }
    const cliFlags = new Set(parseHelpFlags(help.stdout));
    const modeled = new Set(modeledFlags(spec));
    const allow = new Set([...(ALLOW_SKIP["*"] ?? []), ...(ALLOW_SKIP[name] ?? [])]);

    const missing: string[] = [];
    for (const f of cliFlags) {
      if (!modeled.has(f) && !allow.has(f)) missing.push(f);
    }
    if (missing.length) drift = true;
    reports.push({ command: name, missing, unknownCmd: false });
  }

  // ── Report ──
  console.log("flux2 flag drift check:");
  let okCount = 0;
  for (const r of reports) {
    if (r.unknownCmd) {
      console.log(`  ✗ ${r.command} — NOT a real flux2 subcommand (rename/remove in commands.ts)`);
    } else if (r.missing.length) {
      console.log(`  ⚠ ${r.command} — CLI flags not modeled: ${r.missing.join(", ")}`);
    } else {
      okCount++;
      console.log(`  ✓ ${r.command}`);
    }
  }
  console.log(`\n${okCount}/${reports.length} commands fully modeled.`);

  if (drift) {
    console.error(
      "\n✗ Drift detected. Either model the flags in src/commands.ts or allow-list " +
        "them (with a reason) in ALLOW_SKIP in scripts/check-flags.ts.",
    );
    process.exit(1);
  }
  console.log("✓ No drift.");
}

main().catch((err) => {
  console.error("check-flags crashed:", err);
  process.exit(1);
});
