/**
 * check-flags.ts — drift guard. Mirrors s2-agent-ext-flux2's check:flags
 * discipline: assert every flag `ltx-video <cmd> --help` declares is either
 * modeled in src/commands.ts or explicitly allow-listed here.
 *
 *   bun scripts/check-flags.ts
 *
 * Also asserts every command name in commands.ts exists in `ltx-video --help`,
 * so renamed/removed subcommands surface immediately. Exits non-zero on drift.
 */
import { COMMANDS, modeledFlags } from "../src/commands.ts";
import { defaultBinaryPath, ensureBinary, isBinaryStale, resolveRepoRoot } from "../src/binary.ts";
import { invokeLtx } from "../src/invoke.ts";
import { EXTRA_ARG_ALLOW } from "../src/index.ts";

// Flags ltx-video emits that we deliberately do NOT model (builtins / diagnostic-only).
const ALLOW_SKIP: Record<string, string[]> = {
  "*": ["--version", "--help", "-h"],
  // Diagnostic-only timing/caching-experiment flags (project_teacache_style_
  // caching_research memory: "measurement only... quality-verdict prototype,
  // not a default-on optimization") — deliberately not agent-facing.
  t2i: ["--profile-substeps", "--profile-blocks", "--profile-similarity", "--profile-attn-mlp", "--cache-skip-step"],
};

interface Report {
  command: string;
  missing: string[];
  extra: string[];
  unknownCmd: boolean;
}

function parseHelpFlags(stdout: string): string[] {
  const flags = new Set<string>();
  for (const line of stdout.split("\n")) {
    // Only scan the OPTIONS-column part of a flag-definition line (indented,
    // starting with a dash) — skip description/continuation lines, which can
    // themselves contain "--foo"-looking substrings (e.g. an example in the
    // help text) that would otherwise be misread as declared flags.
    if (!/^\s+-/.test(line)) continue;
    // ArgumentParser prints a short+long pair as "-o, --output <meta>" and a
    // `.prefixedNo` inversion pair as "--upscale/--no-upscale <meta>" — both
    // on ONE line. Capture every dash-prefixed token in the leading run
    // (dash-run [,/]-separated), stopping at the metavar/description.
    const head = line.match(/^\s+((?:-{1,2}[\w-]+[,/]?\s*)+)/);
    if (!head) continue;
    for (const m of head[1].matchAll(/--[\w-]+/g)) flags.add(m[0]);
  }
  return [...flags];
}

const EXTRA_ALLOW: Record<string, string[]> = {};

async function main() {
  const bin = await ensureBinary();
  const repoRoot = resolveRepoRoot();

  // ensureBinary() only builds when the binary is entirely absent — a binary
  // left over from before the latest `swift build` silently persists and
  // `--help` reports its (older) flag surface, which reads as "no drift" even
  // when commands.ts is actually behind. Refuse to guard against a stale
  // binary; explicit env override is exempt (caller knows what they're doing).
  if (!process.env.LTX_VIDEO_BIN && isBinaryStale(repoRoot, defaultBinaryPath(repoRoot))) {
    console.error(
      `✗ ${bin} is older than the newest .swift source file — rebuild before running check:flags:\n` +
        `  ( cd swift/ltx-video-director && swift build -c release )`,
    );
    process.exit(1);
  }

  const top = await invokeLtx({ bin, args: ["--help"], cwd: repoRoot });
  if (top.exitCode !== 0) {
    console.error(`✗ ltx-video --help failed (exit ${top.exitCode})\n${top.stderr}`);
    process.exit(1);
  }
  const declaredSubcommands = new Set<string>();
  for (const line of top.stdout.split("\n")) {
    const m = line.match(/^\s{2,}([\w-]+)\s{2,}/);
    if (m) declaredSubcommands.add(m[1]);
  }

  const reports: Report[] = [];
  let drift = false;
  const allRealFlags = new Set<string>(); // union across every command's --help, for EXTRA_ARG_ALLOW's cross-check below

  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (!declaredSubcommands.has(name)) {
      reports.push({ command: name, missing: [], extra: [], unknownCmd: true });
      drift = true;
      continue;
    }
    const help = await invokeLtx({ bin, args: [name, "--help"], cwd: repoRoot });
    if (help.exitCode !== 0) {
      console.error(`✗ ltx-video ${name} --help failed (exit ${help.exitCode})\n${help.stderr}`);
      drift = true;
      continue;
    }
    const cliFlags = new Set(parseHelpFlags(help.stdout));
    for (const f of cliFlags) allRealFlags.add(f);
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

  // index.ts's EXTRA_ARG_ALLOW is a flat, cross-command allow-list — invisible
  // to the per-command missing/extra checks above. Every entry must still
  // name a real flag on SOME command's --help, or it's silently stale.
  const staleExtraArgAllow = [...EXTRA_ARG_ALLOW]
    .filter((name) => !allRealFlags.has(`--${name}`))
    .sort();
  if (staleExtraArgAllow.length) drift = true;

  const topLevelAllow = new Set(ALLOW_SKIP["*"] ?? []);
  const unmodeled = [...declaredSubcommands].filter((c) => !(c in COMMANDS) && !topLevelAllow.has(c)).sort();
  if (unmodeled.length) drift = true;

  console.log("ltx-video flag drift check:");
  let okCount = 0;
  for (const r of reports) {
    if (r.unknownCmd) {
      console.log(`  ✗ ${r.command} — NOT a real ltx-video subcommand (rename/remove in commands.ts)`);
    } else if (r.missing.length || r.extra.length) {
      if (r.missing.length) console.log(`  ⚠ ${r.command} — CLI flags not modeled: ${r.missing.join(", ")}`);
      if (r.extra.length) console.log(`  ⚠ ${r.command} — modeled flags the CLI does NOT have (will always fail at runtime): ${r.extra.join(", ")}`);
    } else {
      okCount++;
      console.log(`  ✓ ${r.command}`);
    }
  }
  console.log(`\n${okCount}/${reports.length} commands fully modeled.`);
  if (unmodeled.length) {
    console.log(`\n✗ ltx-video --help declares subcommand(s) not in commands.ts at all: ${unmodeled.join(", ")}`);
  }
  if (staleExtraArgAllow.length) {
    console.log(
      `\n✗ index.ts's EXTRA_ARG_ALLOW has entr(y/ies) matching no real flag on any command: ${staleExtraArgAllow.join(", ")}`,
    );
  }

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
