/**
 * One-shot research measurement for wayfinder tickets 00 + 03.
 * Dumps per-tool schema cost, categorizes core/gated/ungated, and isolates
 * the _help split pairs. Run: `bun run qa/research-cost.ts`
 */
import {
	buildSchemaCostReport,
	resolveRepoRoot,
} from "../../s2-agent/src/cli/commands/schema-cost.ts";
import { CORPUS_EFF } from "./evaluate.ts";

// TRACKED = the EFFECTIVE tracked set (core ∪ every owner-declared gate name).
// Ticket 15: formerly this was CORE_TOOLS-only (the deleted empty GATES array
// contributed nothing), which mis-reported every owner-declared gated tool
// (flux2/ltx/movie/zai/…) as UNGATED. Routed through CORPUS_EFF.tracked now.
const TRACKED = CORPUS_EFF.tracked;
// obsidian _help tools are CORE, not gated — add them to the help-pair scan.
const CORE_HELP = [...CORPUS_EFF.core].filter((n) => n.endsWith("_help") || n.includes("search_help"));

const report = await buildSchemaCostReport(resolveRepoRoot());
const byName = new Map(report.tools.map((t) => [t.name, t]));
const tok = (n: string) => byName.get(n)?.approxTokens ?? 0;

console.log(`# Research dump — ${report.tools.length} tools, total ${report.totalTokens} tok\n`);

// ── 03: ungated heavy tools (not CORE, not in any GATE) ──
const ungated = report.tools
	.filter((t) => !TRACKED.has(t.name))
	.sort((a, b) => b.approxTokens - a.approxTokens);
console.log("## 03 — Ungated tools (always active, not CORE, not gated):");
console.log("rank  tok    name");
for (const t of ungated) {
	const flag = t.approxTokens >= 150 ? " ⚠" : "";
	console.log(`${String(ungated.indexOf(t) + 1).padStart(3)}   ${String(t.approxTokens).padStart(5)}  ${t.name}${flag}  [${t.source}]`);
}
console.log(`   ungated total: ${ungated.reduce((s, t) => s + t.approxTokens, 0)} tok across ${ungated.length} tools\n`);

// ── 00: _help split pairs ──
console.log("## 00 — _help split pairs (main + _help cost vs hypothetical merged):");
console.log("pair                  main   _help   sum   note");
const pairs: [string, string][] = [
	["flux2", "flux2_help"],
	["krea2", "krea2_help"],
	["ltx", "ltx_help"],
	["movie", "movie_help"],
	["obsidian", "obsidian_help"],
];
for (const [main, help] of pairs) {
	const m = tok(main), h = tok(help);
	const missing = [];
	if (!byName.has(main)) missing.push(`${main}(missing)`);
	if (!byName.has(help)) missing.push(`${help}(missing)`);
	console.log(`${(main + "+" + help).padEnd(20)} ${String(m).padStart(5)}  ${String(h).padStart(5)}  ${String(m + h).padStart(5)}  ${missing.join(" ") || ""}`);
}
console.log(`   CORE-only _help (obsidian_search_help etc.): ${CORE_HELP.join(", ")}`);
for (const h of CORE_HELP) console.log(`     ${h}: ${tok(h)} tok`);

// ── loadedness check (which _help are actually captured) ──
console.log("\n## capture gaps (tools tool-gate references but schema-cost didn't load):");
const missing = [...TRACKED].filter((n) => !byName.has(n));
console.log(missing.length ? missing.join(", ") : "(none — all tracked tools loaded)");
