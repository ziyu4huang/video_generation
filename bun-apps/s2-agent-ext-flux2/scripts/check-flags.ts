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
import { defaultBinaryPath, ensureBinary, isBinaryStale, resolveRepoRoot } from "../src/binary.ts";
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
  extra: string[]; // we model, but the CLI does NOT declare it (schema drift the other direction)
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

// --models-root is injected globally by buildArgv(), never modeled as a
// command field — so it can never appear in modeledFlags() and needs no
// entry here. Nothing else is a legitimate "we model it but the CLI doesn't
// have it" case: a modeled flag with no real CLI counterpart always means
// the CommandSpec drifted (or the flag was renamed/removed on the Swift
// side) — this is exactly the class of bug that shipped 5 wrong fields
// across t2i/edit/style/angle/swap/upscale before this direction was checked.
const EXTRA_ALLOW: Record<string, string[]> = {};

async function main() {
  const bin = await ensureBinary();
  const repoRoot = resolveRepoRoot();

  // ensureBinary() only builds when the binary is entirely absent — a binary
  // left over from before the latest `swift build` silently persists and
  // `--help` reports its (older) flag surface, which reads as "no drift" even
  // when commands.ts is actually behind. Refuse to guard against a stale
  // binary; explicit env override is exempt (caller knows what they're doing).
  if (!process.env.FLUX2_BIN && isBinaryStale(repoRoot, defaultBinaryPath(repoRoot))) {
    console.error(
      `✗ ${bin} is older than the newest .swift source file — rebuild before running check:flags:\n` +
        `  ( cd swift/flux2-image-director && swift build -c release )`,
    );
    process.exit(1);
  }

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
      reports.push({ command: name, missing: [], extra: [], unknownCmd: true });
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
    const extraAllow = new Set(EXTRA_ALLOW[name] ?? []);

    const missing: string[] = [];
    for (const f of cliFlags) {
      if (!modeled.has(f) && !allow.has(f)) missing.push(f);
    }
    // Reverse direction: a flag we model that the CLI does NOT declare. The
    // forward check above only ever catches half of schema drift.
    const extra: string[] = [];
    for (const f of modeled) {
      if (!cliFlags.has(f) && !extraAllow.has(f)) extra.push(f);
    }
    if (missing.length || extra.length) drift = true;
    reports.push({ command: name, missing, extra, unknownCmd: false });
  }

  // ── Report ──
  console.log("flux2 flag drift check:");
  let okCount = 0;
  for (const r of reports) {
    if (r.unknownCmd) {
      console.log(`  ✗ ${r.command} — NOT a real flux2 subcommand (rename/remove in commands.ts)`);
    } else if (r.missing.length || r.extra.length) {
      if (r.missing.length) console.log(`  ⚠ ${r.command} — CLI flags not modeled: ${r.missing.join(", ")}`);
      if (r.extra.length) console.log(`  ⚠ ${r.command} — modeled flags the CLI does NOT have (will always fail at runtime): ${r.extra.join(", ")}`);
    } else {
      okCount++;
      console.log(`  ✓ ${r.command}`);
    }
  }
  console.log(`\n${okCount}/${reports.length} commands fully modeled.`);

  if (drift) {
    console.error(
      "\n✗ Drift detected. Either model the flags in src/commands.ts or allow-list " +
        "them (with a reason) in ALLOW_SKIP (missing) / EXTRA_ALLOW (extra) in scripts/check-flags.ts.",
    );
    process.exit(1);
  }
  console.log("✓ No drift.");
}

main().catch((err) => {
  console.error("check-flags crashed:", err);
  process.exit(1);
});
