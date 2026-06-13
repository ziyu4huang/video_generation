#!/usr/bin/env bun
/**
 * check-runtime — validate that buildCliArgs() OUTPUT is accepted by run.py.
 *
 * check-schema compares the GUI's DECLARED cliFlag/choices/default sets against
 * run.py statically. check-runtime goes one layer further: it exercises
 * buildCliArgs() with param sets synthesized from each field's own metadata, and
 * asserts the EMITTED flag/value tokens satisfy run.py's argparse contract. This
 * catches dynamic integration failures that a static set comparison misses:
 *
 *   flag-accepted   — a concrete emitted --flag run.py rejects (e.g. a typo'd
 *                     cliFlag whose key still passed schema validation).
 *   choice-valid    — a concrete user-selectable value run.py rejects (the exact
 *                     failure mode when a field's choices drift from run.py).
 *   type-valid      — an emitted value that won't parse as run.py's declared type.
 *   required-present— a run.py-required flag the GUI schema doesn't declare at
 *                     all (reverse of check-schema's forward existence check).
 *
 * Source of truth: `run.py schema --compact` (argparse introspection, parse-only,
 * no model loading, no GPU — safe to run anytime). Param values are derived
 * STRICTLY from each field's declared choices/min/max/default — nothing invented.
 *
 * Output modes:
 *   (default)  human-readable text.
 *   --json     { findingCount, findings: [...] } for the schema-self-improve
 *              workflow's runtime lane.
 *
 * Usage: bun run check:runtime [--json]
 */

import path from "path";
import { ALL_COMMANDS } from "../schemas/registry";
import { COMMAND_SCHEMAS } from "../lib/schemas";
import { buildCliArgs } from "../lib/args";
import type { CliField } from "../schemas/toCli";
import { loadConfig, REPO_DIR } from "../lib/config";
import { RUN_PY } from "../lib/paths";

const JSON_MODE = process.argv.includes("--json");

// ── run.py action routing (mirrors check-schema.ts) ─────────────────────────
// GUI actions route through `image <action>` (api/jobs.ts); video-* → `video`.
// run.py flattens sub-action flags onto the top-level command's parser, so flag
// lookup is per top-level command (image | video).

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
  action: string; // "_StoreAction" | "_StoreTrueAction" | "_CountAction" | ...
  nargs?: number | string;
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

/** Argparse actions that emit a bare flag with no following value. */
function isValueless(runArg: RunArg): boolean {
  return runArg.action === "_StoreTrueAction" || runArg.action === "_CountAction";
}

// ── param synthesis (values derived ONLY from declared field metadata) ──────

type Params = Record<string, unknown>;

/** The "all defaults" set: each field at its declared default, omitted if none. */
function defaultParams(fields: Record<string, CliField>): Params {
  const p: Params = {};
  for (const [key, f] of Object.entries(fields)) {
    if (f.default !== undefined) p[key] = f.default;
  }
  return p;
}

/**
 * Synthesize a bounded set of param sets per command, derived strictly from
 * field metadata (never invents values). Shape:
 *   1 × all-defaults
 *   1 × each select-field choice value (one field flipped per set)
 *   1 × every boolean field true (exercises bare-flag emission)
 *   2 × number fields at min, then at max (exercises type-valid at extremes)
 */
function synthesizeParams(action: string): { label: string; params: Params }[] {
  const fields = COMMAND_SCHEMAS[action];
  if (!fields) return [];
  const typedFields = fields as Record<string, CliField>;
  const base = defaultParams(typedFields);
  const sets: { label: string; params: Params }[] = [{ label: "defaults", params: { ...base } }];

  for (const [key, f] of Object.entries(typedFields)) {
    if (f.type === "select" && f.choices) {
      for (const v of f.choices) sets.push({ label: `${key}=${v}`, params: { ...base, [key]: v } });
    }
    if (f.type === "multiselect" && f.choices && f.choices.length) {
      // Emit a single-item array (buildCliArgs expands to repeated --flag value).
      sets.push({ label: `${key}=[${f.choices[0]}]`, params: { ...base, [key]: [f.choices[0]] } });
    }
  }

  const boolKeys = Object.entries(typedFields).filter(([, f]) => f.type === "boolean");
  if (boolKeys.length) {
    const allTrue = { ...base };
    for (const [key] of boolKeys) allTrue[key] = true;
    sets.push({ label: "bools=true", params: allTrue });
  }

  const numKeys = Object.entries(typedFields).filter(([, f]) => f.type === "number");
  if (numKeys.length) {
    const atMin = { ...base };
    const atMax = { ...base };
    for (const [key, f] of numKeys) {
      if (typeof f.min === "number") atMin[key] = f.min;
      if (typeof f.max === "number") atMax[key] = f.max;
    }
    sets.push({ label: "nums=min", params: atMin });
    sets.push({ label: "nums=max", params: atMax });
  }

  return sets;
}

// ── findings ────────────────────────────────────────────────────────────────

type Violation = "flag-accepted" | "choice-valid" | "type-valid" | "control-mismatch" | "required-present" | "build-error";

interface Finding {
  action: string;
  set: string;
  flag: string;
  violation: Violation;
  emitted: unknown;
  expected: unknown;
}

const findings: Finding[] = [];

// ── runtime validation ──────────────────────────────────────────────────────

const schema = fetchRunSchema();
const byCommand: Record<string, Map<string, RunArg>> = {};
for (const [name, cmd] of Object.entries(schema.commands)) {
  byCommand[name] = indexByFlag(cmd.args);
}

for (const cmd of ALL_COMMANDS) {
  const runCmd = commandFor(cmd.action);
  const flagMap = byCommand[runCmd];
  if (!flagMap) continue; // not a generation command routed through image/video

  const fields = (COMMAND_SCHEMAS[cmd.action] || {}) as Record<string, CliField>;
  const declaredFlags = new Set(Object.values(fields).map((f) => f.cliFlag));

  // required-present: a run.py-required flag the GUI schema doesn't declare at
  // all. (We check schema declaration, not per-set emission: a required string
  // field like --prompt is legitimately absent when empty — the GUI's isDisabled
  // guards that — so absence-from-a-set is not a bug; absence-from-schema is.)
  for (const runArg of flagMap.values()) {
    if (!runArg.required) continue;
    for (const flag of runArg.flags) {
      if (!declaredFlags.has(flag)) {
        findings.push({
          action: cmd.action, set: "(schema)", flag,
          violation: "required-present", emitted: "(not declared in GUI schema)",
          expected: "a GUI field with this cliFlag",
        });
      }
    }
  }

  // Exercise buildCliArgs across synthesized param sets; assert each emitted
  // flag/value token against the run.py contract.
  for (const { label, params } of synthesizeParams(cmd.action)) {
    let emitted: string[];
    try {
      emitted = buildCliArgs(cmd.action, params);
    } catch (e) {
      findings.push({
        action: cmd.action, set: label, flag: "(buildCliArgs)",
        violation: "build-error", emitted: String(e), expected: "no throw",
      });
      continue;
    }

    for (let i = 0; i < emitted.length; ) {
      const token = emitted[i];
      if (typeof token !== "string" || !token.startsWith("--")) {
        // A value token where a flag was expected — shouldn't happen given
        // buildCliArgs' emission rules, but record it if it does.
        i++;
        continue;
      }
      const runArg = flagMap.get(token);
      if (!runArg) {
        findings.push({
          action: cmd.action, set: label, flag: token,
          violation: "flag-accepted", emitted: token, expected: "a run.py-accepted flag",
        });
        i++;
        continue;
      }
      if (isValueless(runArg)) {
        i++; // bare boolean flag — no value follows
        continue;
      }
      // run.py expects a value here. If the next token is another flag (or
      // absent), buildCliArgs emitted a bare flag for a GUI field whose run.py
      // arg needs a value — a control/type mismatch (e.g. a GUI toggle whose
      // run.py flag is `--flag FLOAT`). check-schema can't see this (it never
      // compares control/type, only choices/defaults/flag-existence).
      const next = emitted[i + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
        findings.push({
          action: cmd.action, set: label, flag: token,
          violation: "control-mismatch",
          emitted: "(bare flag, no value)",
          expected: `a value (run.py type=${runArg.type ?? "str"})`,
        });
        i++; // advance past the bare flag only — don't swallow the next flag as its value
        continue;
      }
      const value = next;
      i += 2;
      const v = String(value);
      // choice-valid — skip nargs (multiselect) fields: different value model
      // (repeated tokens), comparison is meaningless per check-schema convention.
      if (runArg.choices && runArg.nargs === undefined) {
        if (!runArg.choices.includes(v)) {
          findings.push({
            action: cmd.action, set: label, flag: token,
            violation: "choice-valid", emitted: v, expected: runArg.choices,
          });
        }
      }
      // type-valid
      if (runArg.type === "int" && !/^-?\d+$/.test(v)) {
        findings.push({
          action: cmd.action, set: label, flag: token,
          violation: "type-valid", emitted: v, expected: "int",
        });
      } else if (runArg.type === "float" && Number.isNaN(Number(v))) {
        findings.push({
          action: cmd.action, set: label, flag: token,
          violation: "type-valid", emitted: v, expected: "float",
        });
      }
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────

// Severity tiers (mirror check-schema's ERROR vs WARN split):
//   error   — flag-accepted / required-present / type-valid / build-error:
//             a concrete submission run.py would reject or the GUI can't form.
//   warning — choice-valid: known choices drift (the GUI may intentionally
//             offer values run.py doesn't); surfaced for review, not fatal.
const errorFindings = findings.filter((f) => f.violation !== "choice-valid");
const errorCount = errorFindings.length;

if (JSON_MODE) {
  console.log(JSON.stringify({ findingCount: findings.length, errorCount, findings }));
} else {
  const byAction = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byAction.has(f.action)) byAction.set(f.action, []);
    byAction.get(f.action)!.push(f);
  }
  console.log(
    `Runtime check: ${ALL_COMMANDS.length} GUI command(s) exercised via buildCliArgs() vs run.py (${Object.keys(schema.commands).length} commands)`,
  );
  if (findings.length) {
    console.log(`\n${errorCount ? "✗" : "⚠"}  ${findings.length} runtime finding(s) — ${errorCount} error(s), ${findings.length - errorCount} warning(s):`);
    for (const [action, fs] of byAction) {
      console.log(`  [${action}]`);
      for (const f of fs) {
        const exp = Array.isArray(f.expected) ? `[${f.expected.join(",")}]` : JSON.stringify(f.expected);
        console.log(`    ${f.flag} (${f.violation}, set=${f.set}) — emitted:${JSON.stringify(f.emitted)} expected:${exp}`);
      }
    }
  } else {
    console.log(`\n✓ No runtime findings — every synthesized buildCliArgs() output is accepted by run.py.`);
  }
}

// Only hard errors fail the run (exit 1). choice-valid warnings exit 0 so the
// script stays usable while known drift is pending human review.
if (errorCount > 0) process.exit(1);
