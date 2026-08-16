/**
 * regression_shield + verdict parser — pure, dependency-free.
 *
 * Clean-room port from ../pi-goal-list-loop-audit/extensions/goal-loop-shield.ts
 * (read-only mentor; no runtime coupling). Kept free of pi imports so unit tests
 * exercise it under plain node. `GoalAuditorResult` lives here (not auditor.ts)
 * so format.ts can reference it type-only without importing the pi-bearing
 * auditor module — preserving the Phase-1 "state.ts/format.ts are pi-free" rule.
 */

/** Split a verification contract into its individual checkable items. */
export function contractItems(contract: string): string[] {
	return contract
		.split("\n")
		.map((l) => l.trim())
		.map((l) => l.replace(/^(?:done when|verify|verified when|verification|done)\s*:\s*/i, ""))
		.map((l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
		.filter((l) => l.length > 0)
		.filter((l) => !/^out of scope\b/i.test(l))
		.filter((l) => !l.endsWith(":"))
		.filter((l) => !/^(?:done when\s+)?(?:all of\s+)?the following\b/i.test(l));
}

export interface RegressionShieldResult {
	passed: boolean;
	missingItems: string[];
	hasEvidenceBlock: boolean;
}

function stripEdgePunct(w: string): string {
	return w.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9/_.-]+$/, "");
}

function tokenPresent(candidate: string, reportLower: string): boolean {
	const c = candidate.toLowerCase();
	if (reportLower.includes(c)) return true;
	const segments = c.split(/[-/]+/).filter((s) => s.length >= 3);
	return segments.length > 1 && segments.every((s) => reportLower.includes(s));
}

export function checkRegressionShield(report: string, contract: string): RegressionShieldResult {
	const hasEvidenceBlock = /<evidence>[\t\n\r ]*[\s\S]*?<\/evidence>/i.test(report);
	const items = contractItems(contract);
	const missingItems: string[] = [];
	const reportLower = report.toLowerCase();
	for (const item of items) {
		const candidates = item
			.split(/[^A-Za-z0-9_.\-/]+/)
			.map(stripEdgePunct)
			.filter((w) => w.length >= 5)
			.sort((a, b) => b.length - a.length)
			.slice(0, 3);
		const addressed = candidates.length > 0
			? candidates.some((c) => tokenPresent(c, reportLower))
			: reportLower.includes(item.toLowerCase());
		if (!addressed) missingItems.push(item);
	}
	return { passed: hasEvidenceBlock && missingItems.length === 0, missingItems, hasEvidenceBlock };
}

/** Three-way verdict parser (approved / disapproved / impossible). */
export function parseAuditorVerdict(output: string): {
	approved: boolean;
	disapproved: boolean;
	impossible: boolean;
	impossibleReason?: string;
} {
	const parts = output.split("\n\n");
	const lastAssistant = [...parts].reverse().find((t) => /<\/?(approved|disapproved|impossible)[ />]/i.test(t)) ?? output;
	const impossibleMatch = /<impossible>([\s\S]*?)<\/impossible>/i.exec(lastAssistant);
	return {
		approved: /<approved\/>/i.test(lastAssistant),
		disapproved: /<disapproved\/>/i.test(lastAssistant),
		impossible: impossibleMatch !== null,
		impossibleReason: impossibleMatch?.[1]?.trim().slice(0, 300) || undefined,
	};
}

/**
 * Auditor result data shape. Pure (no pi types) so it can live on ActiveGoal
 * (format.ts) and flow through the session store without dragging pi into the
 * pi-free modules. auditor.ts constructs these; goal.ts consumes them.
 */
export interface GoalAuditorResult {
	approved: boolean;
	disapproved: boolean;
	impossible?: boolean;
	impossibleReason?: string;
	output: string;
	model: string;
	error?: string;
	regressionShieldPassed?: boolean;
	regressionShieldMissing?: string[];
}
