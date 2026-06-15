#!/usr/bin/env bun
/**
 * Code-health knowledge CLI
 *
 * Read-only trend report over gui-movie-director-self-improve runs stored in
 * the knowledge base (knowledge-base/code/). The companion of `knowledge:scan`
 * (generation quality) — this reports CODE-health trends.
 *
 * Usage (from bun/gui-movie-director/):
 *   bun run code-knowledge              # trend report (openIssues, fix rate, most bug-prone)
 *   bun run code-knowledge --records    # list every run record
 *   bun run code-knowledge --json       # machine-readable (applies to either mode)
 */

import { buildCodeReport, readAllCodeRecords } from "../lib/code-knowledge";

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const wantRecords = args.includes("--records");

if (wantRecords) {
  const all = readAllCodeRecords();
  if (wantJson) {
    console.log(JSON.stringify(all, null, 2));
    process.exit(0);
  }
  if (all.length === 0) {
    console.log("No code-knowledge records yet.");
    process.exit(0);
  }
  for (const r of all) {
    console.log(
      `${r.runId}  effort:${r.effort}  fix:${r.fixApplied}  openIssues:${r.openIssues}  verified:${r.findings.verified}`,
    );
  }
  process.exit(0);
}

const report = buildCodeReport();

if (wantJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (report.totalRuns === 0) {
  console.log("No self-improve runs recorded yet. Run the gui-movie-director-self-improve workflow to populate.");
  process.exit(0);
}

const latest = report.latestRun;
console.log(`\nCode-Health Knowledge — ${report.totalRuns} run(s)`);
console.log(
  `Latest: ${latest?.runId ?? "—"}  (effort ${latest?.effort ?? "—"}, openIssues=${latest?.openIssues ?? "—"}, fixApplied=${latest?.fixApplied ?? "—"})\n`,
);

console.log("openIssues trend:", report.openIssuesTrend.join(" → ") || "—");
console.log(`Fix rate: ${report.fixRate}% (applied / verified across history)\n`);

if (report.mostBugProneFiles.length) {
  console.log("Most bug-prone files:");
  for (const f of report.mostBugProneFiles) console.log(`  ${String(f.count).padStart(3)}  ${f.file}`);
  console.log();
}
if (report.recurringDimensions.length) {
  console.log("Recurring finding dimensions:");
  for (const d of report.recurringDimensions) console.log(`  ${String(d.count).padStart(3)}  ${d.dimension}`);
}
