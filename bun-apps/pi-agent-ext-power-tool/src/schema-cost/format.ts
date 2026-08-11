/**
 * Report formatting — pure, no deps. Mirrors the pi-agent `schema-cost`
 * command output so delegation is byte-for-byte.
 */
import type { SchemaCostReport } from "./types.ts";

/**
 * Human-readable ranked table (the `--schema-cost` CLI output).
 * Returns lines (no trailing newline) so callers can `console.log` or write.
 */
export function formatReport(report: SchemaCostReport): string[] {
	const lines: string[] = [];
	lines.push(
		`schema-cost — ${report.tools.length} tools · ≈${report.totalTokens.toLocaleString()} tokens ` +
			`(builtins ${report.builtinCount} + extensions ${report.extensionCount})`,
	);
	if (report.errors.length) {
		lines.push(`${report.errors.length} extension(s) failed to load (run with --schema-cost-json to see):`);
		for (const e of report.errors) lines.push(`  [skip] ${e.source}: ${e.error}`);
	}
	const noExec = report.tools.filter((t) => t.hasExecute === false);
	const badSchema = report.tools.filter((t) => t.schemaValid === false);
	if (noExec.length || badSchema.length) {
		lines.push(`contract ⚠ ${noExec.length} tool(s) missing execute, ${badSchema.length} with invalid schema (run with --schema-cost-json for names)`);
	}
	lines.push("");
	const top3 = report.tools.slice(0, 3);
	const top3Tokens = top3.reduce((s, t) => s + t.approxTokens, 0);
	if (report.totalTokens > 0) {
		lines.push(
			`top 3 — ${top3.map((t) => `${t.name}(${t.approxTokens})`).join(" + ")} = ${top3Tokens} tok ` +
				`(${Math.round((top3Tokens / report.totalTokens) * 100)}% of total)`,
		);
		lines.push("");
	}
	const rows: Record<string, string>[] = report.tools.map((t) => ({
		tool: t.name,
		tokens: String(t.approxTokens),
		desc: String(t.descLen),
		params: String(t.paramsLen),
		source: t.source,
	}));
	const cols = ["tool", "tokens", "desc", "params", "source"];
	const numeric = new Set(["tokens", "desc", "params"]);
	const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
	const fmt = (r: Record<string, string>) =>
		cols
			.map((c, i) => {
				const v = String(r[c] ?? "");
				return numeric.has(c) ? v.padStart(widths[i]!) : v.padEnd(widths[i]!);
			})
			.join("  ")
			.trimEnd();
	const header = Object.fromEntries(cols.map((c) => [c, c])) as Record<string, string>;
	lines.push(fmt(header));
	for (const r of rows) lines.push(fmt(r));
	return lines;
}

/** Machine-readable JSON (the `--schema-cost-json` output). */
export function formatJson(report: SchemaCostReport): string {
	return JSON.stringify(
		{
			tools: report.tools.length,
			totalTokens: report.totalTokens,
			builtinCount: report.builtinCount,
			extensionCount: report.extensionCount,
			errors: report.errors,
			toolsRanked: report.tools.map((t) => ({
				name: t.name,
				approxTokens: t.approxTokens,
				descLen: t.descLen,
				paramsLen: t.paramsLen,
				source: t.source,
				hasExecute: t.hasExecute,
				schemaValid: t.schemaValid,
			})),
		},
		null,
		2,
	);
}
