/**
 * check-flags.ts — drift guard. Mirrors the GUI `check:schema` discipline:
 * assert every flag `krea2 <cmd> --help` declares is either modeled in
 * src/commands.ts or explicitly allow-listed here. Run after editing
 * commands.ts or after a krea2 CLI change.
 *
 *   bun scripts/check-flags.ts
 *
 * Also asserts every command name in commands.ts exists in `krea2 --help`,
 * so renamed/removed subcommands surface immediately. Exits non-zero on drift.
 */
import { COMMANDS, modeledFlags } from "../src/commands.ts";
import { ensureBinary, resolveRepoRoot } from "../src/binary.ts";
import { invokeKrea2 } from "../src/invoke.ts";

// Flags krea2 emits that we deliberately do NOT model (builtins).
const ALLOW_SKIP: Record<string, string[]> = {
  "*": ["--version", "--help", "-h"],
  // t2i's -w/-h are the same field as --width/--height (short aliases); we model
  // the long form only. Help parser surfaces both, so allow-list the shorts.
  t2i: ["-w"],
  i2i: ["-w"],
  controlnet: ["-w"],
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
    // Match "  --flag <meta>" or "  --flag" (boolean) or "  -w, --width".
    const m = line.match(/^\s+(-[\w-]+(?:,\s*)?)?(--[\w-]+)/);
    if (m && m[2]) flags.add(m[2]);
    // Also capture short flags like "  -h, --height" → add "-h"? We model long
    // forms only; shorts are allow-listed above. Capture shorts here so the
    // forward check can decide via ALLOW_SKIP.
    const sm = line.match(/^\s+(-[\w-]+),\s+--/);
    if (sm && sm[1]) flags.add(sm[1]);
  }
  return [...flags];
}

// Nothing is a legitimate "we model it but the CLI doesn't have it" case: a
// modeled flag with no real CLI counterpart always means the CommandSpec
// drifted (or the flag was renamed on the Swift side).
const EXTRA_ALLOW: Record<string, string[]> = {};

async function main() {
  const bin = await ensureBinary();
  const repoRoot = resolveRepoRoot();

  // 1. Verify our command names exist in krea2 --help.
  const top = await invokeKrea2({ bin, args: ["--help"], cwd: repoRoot });
  if (top.exitCode !== 0) {
    console.error(`✗ krea2 --help failed (exit ${top.exitCode})\n${top.stderr}`);
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
    const help = await invokeKrea2({ bin, args: [name, "--help"], cwd: repoRoot });
    if (help.exitCode !== 0) {
      console.error(`✗ krea2 ${name} --help failed (exit ${help.exitCode})\n${help.stderr}`);
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
    const extra: string[] = [];
    for (const f of modeled) {
      if (!cliFlags.has(f) && !extraAllow.has(f)) extra.push(f);
    }
    if (missing.length || extra.length) drift = true;
    reports.push({ command: name, missing, extra, unknownCmd: false });
  }

  // ── Report ──
  console.log("krea2 flag drift check:");
  let okCount = 0;
  for (const r of reports) {
    if (r.unknownCmd) {
      console.log(`  ✗ ${r.command} — NOT a real krea2 subcommand (rename/remove in commands.ts)`);
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
