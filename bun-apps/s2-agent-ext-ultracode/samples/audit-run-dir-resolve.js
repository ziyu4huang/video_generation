/**
 * audit-run-dir-resolve.js — a REAL audit workflow (not a smoke).
 *
 * Target: bun-apps/s2-agent/src/run-dir/resolve.ts — the run-dir argv
 * builder (manifest extensions/skills → absolute -e/--skill paths, with
 * suppression flags). This is the freshest, most relevant code in the repo,
 * so it is a good acceptance target: if the whole chain (built-in workflow
 * tool → real subagents reading files → parallel() → schema-validated
 * synthesis → inline result) works, this returns a structured audit report.
 *
 * (The lazy-extension alias resolver this sample originally audited was
 * removed 2026-08-25, round-2 t11 #2040 — the prompts below were retargeted
 * with it.)
 *
 * Shape: 3 parallel reviewers (distinct lenses) → 1 synthesizer. Bounded on
 * purpose (4 agents) so a real model finishes in minutes, not hours.
 *
 * Run via the REAL e2e path (drives s2-agent CLI + the workflow tool):
 *   PI_MODEL=prism-ml/bonsai-27b \
 *     bun ./bun-apps/s2-agent-ext-ultracode/samples/smoke-e2e.ts \
 *       bun-apps/s2-agent-ext-ultracode/samples/audit-run-dir-resolve.js
 *
 * (This file is a workflow SCRIPT: agent/phase/log/parallel are globals
 * injected by the runtime — do not import them, do not run with `bun` directly.)
 */
export const meta = {
  name: "audit-run-dir-resolve",
  description:
    "Parallel multi-lens audit of src/run-dir/resolve.ts (lazy aliases + deploy argv), then a schema-validated synthesis",
  phases: [{ title: "Review" }, { title: "Synthesize" }],
};

// Findings schema shared by every reviewer lens.
const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "summary", "evidence"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "nit"] },
          summary: { type: "string", description: "one-line statement of the issue" },
          evidence: {
            type: "string",
            description: "file:line reference + the concrete code/state that triggers it",
          },
          failure: {
            type: "string",
            description: "concrete inputs → wrong behavior (optional, omit if none)",
          },
        },
      },
    },
  },
};

const TARGET = "bun-apps/s2-agent/src/run-dir/resolve.ts";

phase("Review");

// Three independent reviewers, each with a DISTINCT lens so redundancy catches
// what a single pass misses. Each reads the file itself (subagents have tools).
const LENSES = [
  {
    key: "correctness",
    prompt: `Read ${TARGET} in full. Audit it for CORRECTNESS bugs only: logic errors, wrong
resolution order, cases where an alias resolves to the wrong path or silently no-ops, argv
mutation bugs (off-by-one, mutating while iterating, skipping the last -e), and any path where
buildArgvFromManifest / suppressResolvedArgv returns a wrong result.
Only report defects you can pin to specific lines with concrete triggering input. If you find
nothing real, return an empty findings array — do not invent issues.`,
  },
  {
    key: "edge-cases",
    prompt: `Read ${TARGET} in full. Audit it for EDGE-CASES only: empty string, leading dash
("-e -p" where the next token is a flag), malformed manifest entries (missing 'entry'), npm-path
resolution, missing bunAppsDir, and mode guards. For each, give
the exact input and the observed/predicted behavior. Only real defects with line references.
Empty array if nothing real.`,
  },
  {
    key: "test-coverage",
    prompt: `Read ${TARGET} AND the test file bun-apps/s2-agent/src/run-dir/resolve.test.ts. Identify
GAPS where a real defect would NOT be caught by the current tests: untested branches of
buildArgvFromManifest, suppressResolvedArgv, and the mode guards. For each gap name the branch
and the minimal test that would cover it.
Only material gaps (a bug could hide there). Empty array if coverage is solid.`,
  },
];

const reviews = await parallel(
  LENSES.map((lens) => () =>
    agent(lens.prompt, {
      label: `review:${lens.key}`,
      phase: "Review",
      schema: FINDINGS_SCHEMA,
      tier: "medium",
    }),
  ),
);

// Flatten + count, keeping the lens provenance on each finding.
const all = [];
for (let i = 0; i < LENSES.length; i++) {
  const r = reviews[i];
  if (!r || !Array.isArray(r.findings)) continue;
  for (const f of r.findings) all.push({ ...f, lens: LENSES[i].key });
}
log(`collected ${all.length} raw findings across ${LENSES.length} lenses`);

phase("Synthesize");

// One synthesizer dedupes + ranks. It receives the flattened findings inline
// (no re-read needed) and returns the final adjudicated report.
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };
const sorted = all
  .slice()
  .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));

const SYNTH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["confirmed", "dismissed", "summary"],
  properties: {
    summary: { type: "string", description: "2-3 sentence overall assessment of the file's health" },
    confirmed: {
      type: "array",
      description: "findings that survive scrutiny — real defects or real coverage gaps",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "summary", "evidence", "lens"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "nit"] },
          summary: { type: "string" },
          evidence: { type: "string" },
          lens: { type: "string" },
        },
      },
    },
    dismissed: {
      type: "array",
      description: "findings rejected as false positives, with the reason",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "reason"],
        properties: {
          summary: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

const report = await agent(
  `You are the synthesizer for an audit of ${TARGET}. Below are findings from three independent
reviewers (correctness / edge-cases / test-coverage), sorted by severity. Adjudicate each:
keep the ones that are real defects or real coverage gaps in "confirmed", move false positives to
"dismissed" with a one-line reason. Deduplicate near-identical findings across lenses (keep the
clearest statement). Then write a 2-3 sentence "summary" of the file's overall health.

Raw findings (JSON):
${JSON.stringify(sorted, null, 2)}`,
  { label: "synthesize", phase: "Synthesize", schema: SYNTH_SCHEMA, tier: "big" },
);

return report;
