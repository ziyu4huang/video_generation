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
 * Output modes:
 *   (default)  human-readable text.
 *   --json     structured findings for machine consumers (the schema-self-improve
 *              workflow's drift-fix lane). Emits { warnings, errors, counts }.
 *
 * Multiselect fields (control === "images") skip the choices/default comparison:
 * their GUI representation (comma-string default, repeated choices) is a display
 * artifact, not drift — the flag's existence is still checked.
 *
 * Usage: bun run check:schema [--json]
 */

import { ALL_COMMANDS } from "../schemas/registry";
import { subcommand } from "../lib/actionToCommand";
import type { RunArg } from "./schema-utils";
import { fetchRunSchema, indexByFlag } from "./schema-utils";

const JSON_MODE = process.argv.includes("--json");

// ── structured findings ─────────────────────────────────────────────────────

type Category = "gui_missing_choice" | "runpy_narrow" | "mixed_choices" | "default_mismatch";

interface Finding {
  action: string;
  flag: string;
  key: string;
  kind: "choices" | "default";
  category: Category;
  guiValue: unknown;
  runValue: unknown;
}

function choicesCategory(guiVals: string[], runVals: string[]): Category {
  const runExtra = runVals.filter((v) => !guiVals.includes(v));
  const guiExtra = guiVals.filter((v) => !runVals.includes(v));
  if (runExtra.length && guiExtra.length) return "mixed_choices";
  if (runExtra.length) return "gui_missing_choice";
  if (guiExtra.length) return "runpy_narrow";
  return "mixed_choices"; // unreachable if sets differ, but keep exhaustive
}

// ── drift check ─────────────────────────────────────────────────────────────

const errors: string[] = [];
const findings: Finding[] = [];

const schema = fetchRunSchema();
const byCommand: Record<string, Map<string, RunArg>> = {};
for (const [name, cmd] of Object.entries(schema.commands)) {
  byCommand[name] = indexByFlag(cmd.args);
}

for (const cmd of ALL_COMMANDS) {
  const runCmd = subcommand(cmd.action);
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
    // Multi-value fields: GUI and run.py use different value models (multiselect
    // UI, or composite preset strings vs run.py nargs tokens), so choices/default
    // comparison is meaningless — only the flag's existence is meaningful here.
    if (f.control === "images" || arg.nargs !== undefined) continue;

    // choices: GUI choice values vs run.py's choice set.
    if (f.choices && arg.choices) {
      const guiVals = f.choices.map((c) => c.value).sort();
      const runVals = [...arg.choices].sort();
      if (JSON.stringify(guiVals) !== JSON.stringify(runVals)) {
        findings.push({
          action: cmd.action,
          flag: f.cliFlag,
          key: f.key,
          kind: "choices",
          category: choicesCategory(guiVals, runVals),
          guiValue: guiVals,
          runValue: runVals,
        });
      }
    }
    // default: surface divergence (GUI may intentionally differ).
    if (f.default !== undefined && arg.default !== undefined && arg.default !== null) {
      if (f.default !== arg.default) {
        findings.push({
          action: cmd.action,
          flag: f.cliFlag,
          key: f.key,
          kind: "default",
          category: "default_mismatch",
          guiValue: f.default,
          runValue: arg.default,
        });
      }
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────

if (JSON_MODE) {
  const payload = {
    warningCount: findings.length,
    errorCount: errors.length,
    warnings: findings,
    errors,
  };
  console.log(JSON.stringify(payload));
} else {
  console.log(
    `Schema drift check: ${ALL_COMMANDS.length} GUI command(s) vs run.py (${Object.keys(schema.commands).length} commands)`,
  );
  if (findings.length) {
    console.log(`\n⚠  ${findings.length} warning(s) — informational:`);
    for (const fnd of findings) {
      const vals = fnd.kind === "choices"
        ? `GUI:[${(fnd.guiValue as string[]).join(",")}] run.py:[${(fnd.runValue as string[]).join(",")}]`
        : `GUI:${JSON.stringify(fnd.guiValue)} run.py:${JSON.stringify(fnd.runValue)}`;
      console.log(`   [${fnd.action}] ${fnd.flag} ${fnd.kind} differ (${fnd.category}) — ${vals}`);
    }
  }
  if (errors.length) {
    console.log(`\n✗ ${errors.length} drift error(s) — GUI flags run.py does not accept:`);
    for (const e of errors) console.log(`   ${e}`);
  } else {
    console.log(`\n✓ No drift — every GUI cliFlag is accepted by run.py.`);
  }
}

if (errors.length) process.exit(1);
