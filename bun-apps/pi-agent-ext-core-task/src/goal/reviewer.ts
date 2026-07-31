// pi-agent-ext-core-task — src/goal/reviewer.ts
// (core-task port of GLA's Reviewer)
//
// The Reviewer: post-completion follow-up enqueuer. Fires after a /goal
// completes or a /list queue empties, extracts findings from the archive
// + ledger, classifies them by leverage, writes a review report, and
// cascades: bug/refactor findings → /list items (no Confirm, per the
// leverage principle), architectural findings → /goal proposal (Confirm),
// clean completions → audit /goal proposal, strategic-only → notify+idle.
//
// This module currently ships the first half of the port: config, types,
// finding classification, and text helpers. The lifecycle (extractFindings,
// runReviewer, report types, ReviewerDeps/ReviewerOutcome,
// reviewerMenuOptions) is appended in a follow-up task.
//
// Deterministic by design (REVIEWER-DESIGN-2026-07-24: "makes NO new tool
// calls — purely analytical"). All side effects are injected so tests
// drive it without a pi host. /loop completions never trigger it.

import * as fs from "node:fs";
import * as path from "node:path";

export type ReviewerMode = "off" | "on" | "auto" | "aggressive";

export interface ReviewerConfig {
	enabled: boolean;
	/** v0.26.2: default = Confirm-gated cascade; auto = auto-loop — every
	 * finding class (incl. architectural) and the clean-completion audit
	 * become /list items with zero Confirms (strategic stays notify-only —
	 * decisions never auto-fire); report = write the report + notify only. */
	mode: ReviewerMode;
	fireOn: Array<"goal-complete" | "list-complete">;
	doNotFireOn: string[];
	cascade: Array<"convert-findings-to-list" | "queue-leftovers" | "fire-audit-on-clean" | "notify-and-idle">;
	auditCadence: string;
	auditScope: string;
	leverageMode: "fix-without-confirm" | "confirm-all";
	confirmOn: string[];
	maxFindingsPerReview: number;
	maxReviewsPerDay: number;
}

export const DEFAULT_REVIEWER_CONFIG: ReviewerConfig = {
	enabled: true,
	mode: "on",
	fireOn: ["goal-complete", "list-complete"],
	doNotFireOn: ["goal-aborted", "goal-paused"],
	cascade: ["convert-findings-to-list", "queue-leftovers", "notify-and-idle"],
	auditCadence: "every-clean-completion",
	auditScope: "regression-scan",
	leverageMode: "fix-without-confirm",
	confirmOn: ["architectural-decision", "new-dependency", "schema-change"],
	maxFindingsPerReview: 10,
	maxReviewsPerDay: 20,
};

/** Merge a partial project-settings block over the defaults. v0.27.9:
 * migrate legacy `"default"` / `"report"` mode values to `"on"` (the
 * contract-compliant 4-mode set is now `off | on | auto | aggressive`). */
export function resolveReviewerConfig(block?: Partial<ReviewerConfig>): ReviewerConfig {
	const merged = { ...DEFAULT_REVIEWER_CONFIG, ...(block ?? {}) };
	if ((merged.mode as string) === "default" || (merged.mode as string) === "report") {
		merged.mode = "on";
	}
	return merged;
}

export type FindingClass = "bug" | "refactor" | "architectural" | "strategic";

export interface Finding {
	text: string;
	source: string;
	class: FindingClass;
}

/** Leverage classification (contract item 5). Order matters: strategic
 * and architectural win over bug/refactor — "should we rewrite this
 * broken schema" is a decision, not a fix. */
// v0.26.3: the bare words "architectural"/"strategic" are REMOVED — they
// self-matched the reviewer's own vocabulary ("architectural-class",
// "architectural findings", the docs' mode matrix) and produced 3 junk
// findings on the 0.26.2 completion, observed live.
const CLASS_PATTERNS: Array<{ class: FindingClass; re: RegExp }> = [
	{ class: "strategic", re: /\bshould we\b|\bdeprecat|ship this\??/i },
	{ class: "architectural", re: /\brewrite\b|new dependency|schema change|\bredesign\b/i },
	{ class: "bug", re: /\bTODO\b|\bFIXME\b|\bbug\b|\bissue\b|regression|broken|\bfixme\b/i },
	{ class: "refactor", re: /could be cleaner|consider refactoring|duplicat|refactor|left ?out|follow[\s-]?up|deferred|could be improved|improvement|enhancement|consider adding|would be nice|nice to have/i },
];

/** v0.26.3: lines that never carry findings — code, markdown tables, and
 * the reviewer's own report/config vocabulary. Observed false positives
 * from the 0.26.2 completion: a test("…architectural…") name, the
 * INSTALL.md mode-matrix row, and ship-doc prose. */
const SKIP_LINE = /^\s*(test|it|describe|assert|expect)\s*\(|^\s*(const|let|var|function|import|export|require)\b|\{\s*\.\.\.\s*\}|,\s*\.\.\.$|^\s*\||^\s*[{\[\]}]|^\s*['"]|^\s*ℹ/; // ℹ = test-runner/status noise ("ℹ todo 0" was enqueued as a /list item by the 0.26.2 reviewer)
const REVIEWER_VOCAB = /architectural-class|bug-class|refactor-class|strategic-class|reviewer found|cascade step|\*\*Mode\*\*|problems\s*\/\s*\(?(improvements|architectural)/i;

export function classifyFindingText(line: string): FindingClass | undefined {
	// Strip list markers here too (extractFindings already does, but direct
	// callers/tests pass raw report lines like "- ℹ todo 0").
	const t = line.trim().replace(/^[-*>\s\[\]x]+/, "");
	if (t.length < 8) return undefined;
	if (SKIP_LINE.test(t) || REVIEWER_VOCAB.test(t)) return undefined;
	for (const { class: cls, re } of CLASS_PATTERNS) {
		if (re.test(t)) return cls;
	}
	return undefined;
}

/** v0.26.4: remove fenced code blocks and inline code spans. Quoted
 * code is how completion summaries leak vocabulary into extraction —
 * the 0.26.3 misfire matched a backticked reviewer.ts line containing
 * four architectural patterns. */
export function stripCodeSpans(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ");
}

/** v0.28.24: join hard-wrapped lines before classification. Completion
 * summaries and transcripts arrive wrapped at ~70 cols, and line-by-line
 * extraction sliced findings at the wrap point (field-observed in
 * hellhunter: a list item whose ENTIRE objective was "Run a post-completion
 * regression scan on the hellhunter codebase to" — the first visual line of
 * a wrapped paragraph, enqueued by the convert-findings-to-list cascade).
 * A line that doesn't end a sentence continues on the next line unless that
 * line starts a new list item or heading. */
export function unwrapHardWrappedLines(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const prev = out[out.length - 1];
		const startsNewItem = /^\s*([-*•>]|\d+[.)]|#)/.test(line);
		// v0.28.24: join only when the continuation starts LOWERCASE — the
		// mid-sentence signal. Punctuation-less standalone items ("TODO: fix x")
		// start uppercase/keyword and must NOT merge with the next item.
		const continuesSentence = /^[a-z]/.test(line.trimStart());
		if (
			prev !== undefined &&
			prev.trim().length > 0 &&
			line.trim().length > 0 &&
			!startsNewItem &&
			continuesSentence &&
			!/[.!?:;)"'\]]$/.test(prev.trimEnd())
		) {
			out[out.length - 1] = `${prev.trimEnd()} ${line.trimStart()}`;
		} else {
			out.push(line);
		}
	}
	return out.join("\n");
}

/** v0.28.24: a candidate ending in a dangling connector is a wrap/parse
 * fragment, not a finding ("…codebase to", "…the settings and"). */
const DANGLING_END = /\s(to|and|or|but|the|a|an|of|for|with|in|on|at|that|which|into|from|by|is|are|was|were|be|been|so|if|then|than|as|nor|yet|per|via)$/i;

/** v0.28.24: cut at a clause boundary, never mid-word — the finding text IS
 * the item's user-facing name once enqueued. */
export function cutAtClauseBoundary(s: string, max: number): string {
	if (s.length <= max) return s;
	const window = s.slice(0, max);
	const clause = Math.max(
		window.lastIndexOf(". "),
		window.lastIndexOf("! "),
		window.lastIndexOf("? "),
		window.lastIndexOf("; "),
		window.lastIndexOf(", "),
		window.lastIndexOf(" — "),
		window.lastIndexOf(": "),
	);
	if (clause >= Math.floor(max * 0.4)) return window.slice(0, clause + 1).trimEnd();
	const space = window.lastIndexOf(" ");
	return (space > 0 ? window.slice(0, space) : window).trimEnd();
}

/** v0.28.16: normalize an objective for duplicate-compare — lowercase,
 * goal-ids (yyyyMMddHHmmss-xxxxxx) become <id>, whitespace collapses. */
export function normalizeObjective(s: string): string {
	return s
		.toLowerCase()
		.replace(/\b\d{14}-[a-z0-9]{6}\b/g, "<id>")
		.replace(/\s+/g, " ")
		.trim();
}
