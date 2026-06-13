#!/usr/bin/env bun
/**
 * check-schema — verify GUI command schemas against the run.py CLI contract.
 *
 * run.py's argparse is the single source of truth (emitted by `run.py schema`).
 * This script asserts every cliFlag the GUI declares is actually accepted by the
 * matching run.py command, so drift fails loudly here instead of silently at
 * runtime (e.g. a renamed/removed flag the GUI still sends → run.py error).
 *
 * Tiers:
 *   ERROR (exit 1): GUI cliFlag not accepted by run.py — real drift.
 *   WARN  (printed): default / choices mismatch — informational; the GUI may
 *                    intentionally differ, but it's worth surfacing.
 *
 * Usage: bun run check:schema   (or: bun run scripts/check-schema.ts)
 */

import path from "path";
import { ALL_COMMANDS } from "../schemas/registry";
import { loadConfig, REPO_DIR } from "../lib/config";
import { RUN_PY } from "../lib/paths";

// ── run.py action routing ───────────────────────────────────────────────────
// GUI actions route through `image <action>` by default (see api/jobs.ts);
// video-* actions route through `video <action>`. All sub-action flags are
// flattened onto the top-level command's parser, so flag lookup is per
// top-level command (image | video).

function commandFor(action: string): string {
  return action.startsWith("video-") ? "video" : "image";
}

// ── run.py schema shape (mirror of app/commands/schema.py output) ───────────

interface RunArg {
  flags: string[];
  dest: string;
  type?: string;
  default?: unknown;
  choices?: string[];
  action: string;
  nargs?: unknown;
  required: boolean;
  help?: string;
}
interface RunCommand {
  args: RunArg[];
  positionals: RunArg[];
}
interface RunSchema {
  commands: Record<string, RunCommand>;
}

function fetchRunSchema(): RunSchema {
  const cfg = loadConfig();
  const pythonBin = cfg.pythonPath?.trim() || path.join(REPO_DIR, "python", "venv", "bin", "python");
  const proc = Bun.spawnSync(
    [pythonBin, RUN_PY, "schema", "--compact"],
    { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
  );
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  if (!stdout) {
    throw new Error(`run.py schema produced no output${stderr ? `: ${stderr}` : ""}`);
  }
  return JSON.parse(stdout) as RunSchema;
}

function indexByFlag(args: RunArg[]): Map<string, RunArg> {
  const m = new Map<string, RunArg>();
  for (const a of args) for (const f of a.flags) m.set(f, a);
  return m;
}

// ── drift check ─────────────────────────────────────────────────────────────

const errors: string[] = [];
const warnings: string[] = [];

const schema = fetchRunSchema();
const byCommand: Record<string, Map<string, RunArg>> = {};
for (const [name, cmd] of Object.entries(schema.commands)) {
  byCommand[name] = indexByFlag(cmd.args);
}

for (const cmd of ALL_COMMANDS) {
  const runCmd = commandFor(cmd.action);
  const flagMap = byCommand[runCmd];
  if (!flagMap) {
    errors.push(`[${cmd.action}] run.py has no '${runCmd}' command`);
    continue;
  }
  for (const f of cmd.fields) {
    if (!f.cliFlag) continue;
    const arg = flagMap.get(f.cliFlag);
    if (!arg) {
      // Hard drift: the GUI would emit a flag run.py rejects.
      errors.push(`[${cmd.action}] ${f.cliFlag} (${f.key}) not accepted by run.py '${runCmd}'`);
      continue;
    }
    // choices: GUI choice values should match run.py's choice set exactly.
    if (f.choices && arg.choices) {
      const guiVals = f.choices.map((c) => c.value).sort();
      const runVals = [...arg.choices].sort();
      if (JSON.stringify(guiVals) !== JSON.stringify(runVals)) {
        warnings.push(
          `[${cmd.action}] ${f.cliFlag} choices differ — GUI:[${guiVals.join(",")}] run.py:[${runVals.join(",")}]`,
        );
      }
    }
    // default: surface divergence (GUI may intentionally differ — warn only).
    if (f.default !== undefined && arg.default !== undefined && arg.default !== null) {
      if (f.default !== arg.default) {
        warnings.push(
          `[${cmd.action}] ${f.cliFlag} default differs — GUI:${JSON.stringify(f.default)} run.py:${JSON.stringify(arg.default)}`,
        );
      }
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────

console.log(
  `Schema drift check: ${ALL_COMMANDS.length} GUI command(s) vs run.py (${Object.keys(schema.commands).length} commands)`,
);

if (warnings.length) {
  console.log(`\n⚠  ${warnings.length} warning(s) — informational:`);
  for (const w of warnings) console.log(`   ${w}`);
}

if (errors.length) {
  console.log(`\n✗ ${errors.length} drift error(s) — GUI flags run.py does not accept:`);
  for (const e of errors) console.log(`   ${e}`);
  process.exit(1);
}

console.log(`\n✓ No drift — every GUI cliFlag is accepted by run.py.`);
