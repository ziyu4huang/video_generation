#!/usr/bin/env bun
//
// archify mermaid → IR converter — the phase-2 authoring-flow console step.
//
//   bun run mermaid:convert <input.mmd> [--type workflow|architecture|dataflow]
//                            [--out <ir.json>] [--no-validate]
//
// Converts a bounded mermaid subset (flowchart/sequenceDiagram/stateDiagram —
// see .planning/2026-08-23-archify-rich-decks spec.md §7.1 and
// src/mermaid-convert.ts) to an archify IR, then VALIDATES it with the vendored
// archify CLI in the same call: the "valid IR out" contract (ticket 20).
//
//   exit 0 — converted AND valid (the IR is on stdout, or written by --out)
//   exit 1 — conversion failed (parse / bound error) or validation failed
//            (diagnostics printed; the IR file is still written with --out)
//   exit 2 — usage error (unknown flag, --type on an auto-dialect, …)
//
// Output: pretty JSON to stdout by default; --out <path> writes the file and
// sets `meta.output` to `<stem>.html` (the schema's artifact-name convention),
// so the emitted IR is copy-adaptable in-place.
//
// The unbounded-syntax list lives in src/mermaid-convert.ts headers + --help
// below: style-only constructs (linkStyle, unmatched classDef, %%{init}) are
// dropped per the vendored doc's "Drop Mermaid styling"; everything
// meaning-bearing that is not in the dialect table is a hard error with line.
//
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertMermaid, detectMermaidDialect, MermaidConvertError, validateWithLabelFixes, type ConverterTarget } from "../src/mermaid-convert.ts";
import { runArchify, withTempIr } from "../src/run.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface MermaidConvertArgs {
  input: string;
  type?: ConverterTarget;
  out?: string;
  noValidate?: boolean;
}

export function printVersion(): string {
  return "archify mermaid→IR converter — convert + validate in one call (ticket 20)";
}

export function helpText(): string {
  return `Usage: bun run mermaid:convert <input.mmd> [--type workflow|architecture|dataflow]
                                          [--out <ir.json>] [--no-validate]

Converts a bounded mermaid subset to an archify IR, then validates it with the vendored
archify CLI in the same call (the valid-IR-out contract). The IR JSON goes to stdout (or to
--out, which also sets meta.output); status lines go to stderr.

  --type workflow|architecture|dataflow   target for flowchart input (default: workflow;
                                          sequenceDiagram → sequence, stateDiagram → lifecycle
                                          auto-detect — --type on those is an error)
  --out <file>                            write the IR file (adds meta.output = <stem>.html)
  --no-validate                           convert only, skip the vendored validate gate

Exit codes: 0 converted+valid · 1 conversion/validation failure · 2 usage error.

Dialect bound (v1) — supported: flowchart/graph direction + node aliases with shapes
[] / () / {} / [()], links --> / -.-> / ==> / -- text --> / -. text .-> / |label| pipes,
subgraphs (1 level), classDef / style / class / :::class; sequence participant/actor,
messages ->> / -->>, |+|−| activation shorthand, Note over/right of/left of, rect blocks,
activate/deactivate; state state "Label" as X, [*] entry/exit, A --> B: label.

SYNTAX NOT SUPPORTED — a hard error with the source line, never a silent drop:
sequence alt/loop/opt/par/break blocks, -)>/--x variants, state composites (state X {...})
and forks, flowchart && node links, nested subgraphs, same-lane skip edges, cycles crossing
same-column intermediate lanes, cross-lane fan-out that the vendored router cannot clear.

Dropped as styling per the vendored doc ("Drop Mermaid styling"): linkStyle, classDef names
with no semantic signal, %%{init} blocks, and the flowchart direction is normalized to
left-to-right (layering is the copy-adapt judgment, D7).`;
}

export function parseArgs(argv: string[]): MermaidConvertArgs {
  const positional: string[] = [];
  let type: ConverterTarget | undefined;
  let out: string | undefined;
  let noValidate = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${printVersion()}\n\n${helpText()}\n`);
      process.exit(0);
    }
    if (a === "--type") {
      const v = argv[++i];
      if (v !== "workflow" && v !== "architecture" && v !== "dataflow") {
        throw new MermaidConvertError(`--type must be workflow|architecture|dataflow, got "${v}"`, null);
      }
      type = v;
      continue;
    }
    if (a === "--out") {
      out = argv[++i];
      if (out === undefined) throw new MermaidConvertError("--out needs a file path", null);
      continue;
    }
    if (a === "--no-validate") {
      noValidate = true;
      continue;
    }
    if (a.startsWith("--")) throw new MermaidConvertError(`unknown flag: ${a}`, null);
    positional.push(a);
  }
  if (positional.length === 0) throw new MermaidConvertError("missing <input.mmd>", null);
  if (positional.length > 1) throw new MermaidConvertError(`one input file expected, got ${positional.length}`, null);
  return { input: positional[0]!, ...(type ? { type } : {}), ...(out ? { out } : {}), ...(noValidate ? { noValidate } : {}) };
}

function fail(msg: string): never {
  console.error(`mermaid: ${msg}`);
  process.exit(1);
}

/** Parse the vendored validate JSON receipt; returns ok + diagnostics text. */
function judgeReceipt(stdout: string): { ok: boolean; text: string } {
  try {
    const parsed = JSON.parse(stdout) as {
      ok?: boolean;
      error?: string;
      diagnostics?: Array<{ code?: string; severity?: string; message?: string; subject?: { path?: string } }>;
      checks?: unknown;
      composition?: { summary?: { warnings?: number } };
    };
    if (parsed.ok) {
      const warnings = (parsed.composition as { summary?: { warnings?: number } })?.summary?.warnings ?? 0;
      const checks = Array.isArray(parsed.checks) ? parsed.checks.length : "—";
      return { ok: true, text: `VALID (schema v1 · checks ${checks} · composition warnings ${warnings})` };
    }
    const diags = (parsed.diagnostics ?? [])
      .map((d) => `  ${d.severity ?? "?"} ${d.code ?? "?"} ${d.message ?? ""}${d.subject?.path ? ` (${d.subject.path})` : ""}`)
      .join("\n");
    return { ok: false, text: diags || `invalid: ${parsed.error ?? "unknown"}` };
  } catch {
    return { ok: false, text: `validate receipt unreadable: ${stdout.slice(0, 300)}` };
  }
}

/** Validate an IR through the vendored bin; verdict feeds the shared fix loop. */
async function validateThroughBin(
  ir: Record<string, unknown>,
  diagramType: string,
): Promise<{ ok: boolean; text: string; diagnostics: Array<{ message?: string }> }> {
  const receipt = await withTempIr(ir, async (irPath) => {
    const res = await runArchify(["validate", diagramType, irPath, "--json"], PKG_ROOT);
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  });
  if (receipt.status === null) {
    fail(`validate failed to launch\n${receipt.stderr}`);
  }
  const verdict = judgeReceipt(receipt.stdout);
  if (verdict.ok) return { ok: true, text: verdict.text, diagnostics: [] };
  try {
    const parsed = JSON.parse(receipt.stdout) as { diagnostics?: Array<{ message?: string }> };
    return { ok: false, text: verdict.text, diagnostics: parsed.diagnostics ?? [] };
  } catch {
    return { ok: false, text: verdict.text, diagnostics: [] };
  }
}

async function main(): Promise<void> {
  let args: MermaidConvertArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof MermaidConvertError) {
      console.error(`usage: mermaid: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const inputPath = resolve(args.input);
  const source = await Bun.file(inputPath).text();

  const stem = basename(inputPath, extname(inputPath));
  const outStem = args.out ? basename(args.out, extname(args.out)) : undefined;
  if (args.type && detectMermaidDialect(source) !== "flowchart") {
    // Usage error → exit 2 (the dialect decides; --type is workflow-only).
    console.error(`usage: mermaid: ${args.type ? "--type is only for flowchart input" : ""}`);
    process.exit(2);
  }
  let ir: Record<string, unknown>;
  try {
    ir = convertMermaid(source, { title: stem, ...(args.type ? { type: args.type } : {}), ...(outStem ? { outputStem: outStem } : {}) });
  } catch (e) {
    if (e instanceof MermaidConvertError) fail(e.message);
    throw e;
  }

  const diagramType = String(ir.diagram_type ?? "");

  if (args.noValidate) {
    emit(args, ir, diagramType, stem);
    console.error(`converted (NOT validated) — ${diagramType} · ${stem}`);
    process.exit(0);
  }

  // Convert + validate in one call, with the checker-driven label fix loop
  // (shared validateWithLabelFixes): label overlaps get their suggested labelAt
  // applied, then re-validated; anything else fails with the diagnostics.
  const { ir: finalIr, verdict: finalVerdict } = await validateWithLabelFixes(ir, (candidate) =>
    validateThroughBin(candidate, diagramType),
  );
  if (!finalVerdict.ok) {
    emit(args, finalIr, diagramType, stem);
    fail(`conversion failed validation:\n${finalVerdict.text}`);
  }
  emit(args, finalIr, diagramType, stem);
  console.error(`mermaid → ${diagramType}: ${finalVerdict.text}`);
  process.exit(0);
}

/** stdout carries THE IR JSON (pipe-clean for `| jq` / `> dir`); all status
 * lines go to stderr. */
function emit(args: MermaidConvertArgs, ir: Record<string, unknown>, diagramType: string, stem: string): void {
  const json = JSON.stringify(ir, null, 2);
  if (args.out) {
    const outPath = resolve(args.out);
    Bun.write(outPath, `${json}\n`);
    console.error(`ir      ${outPath}`);
  } else {
    console.log(json);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    if (e instanceof MermaidConvertError) fail(e.message);
    fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
  });
}
