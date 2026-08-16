/**
 * Regression: multi-select questions MUST render the checkbox view
 * (MultiSelectView) so the user sees [✔] state + a Next sentinel, and the
 * selection MUST survive Space→Down→Next→Enter to the tool result.
 *
 * Root cause: DialogView.renderQuestionBody hardcoded tab.optionList.render()
 * for every question — OptionListView (plain WrappingSelect) has no checkbox
 * affordance and ignores multiSelectChecked, so toggles had ZERO visual
 * feedback ("I cannot choice") and the user couldn't tell how to submit.
 * MultiSelectView was built + prop-driven but never rendered (orphan).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { __setLocaleForTest } from "../state/i18n-bridge.js";
import { QuestionnaireSession } from "../state/questionnaire-session.js";
import { buildItemsForQuestion } from "../ask-user-question.js";
import type { QuestionParams, QuestionnaireResult } from "../tool/types.js";

// Minimal theme: pass strings through so render() output is assertion-friendly.
const theme = new Proxy(
	{},
	{
		get:
			() =>
			(...args: unknown[]) =>
				args.map((a) => (typeof a === "string" ? a : "")).join(""),
	},
) as never;

const MULTI: QuestionParams = {
	questions: [
		{
			question: "Which CI fixes?",
			header: "CI refine",
			multiSelect: true,
			options: [
				{ label: "Fix docs count", description: "x" },
				{ label: "Reusable workflow", description: "x" },
				{ label: "setup-node conditional", description: "x" },
				{ label: "Spotcheck move", description: "x" },
			],
		},
	],
};

function makeSession(capture: { result?: QuestionnaireResult }) {
	const itemsByTab = MULTI.questions.map((q) => buildItemsForQuestion(q));
	return new QuestionnaireSession({
		tui: { terminal: { columns: 120, rows: 40 }, requestRender: () => {} },
		theme,
		params: MULTI,
		itemsByTab,
		done: (result) => {
			capture.result = result;
		},
		collapseKey: "off",
	});
}

function renderBody(s: { component: { render(w: number): string[] } }): string {
	// skip the header + footer lines, keep the body
	return s.component.render(120).join("\n");
}

// Determinism: this regression asserts ENGLISH chrome literals (Next sentinel,
// "Space to toggle"). Those are t()-localized, so under a zh-TW locale (e.g. a
// developer who set `askUserLanguage`) they render as translated strings and
// the assertions break. Pin locale=en for this file so it is deterministic
// regardless of ambient ~/.pi/agent/settings.json, and restore the pin after so
// it never leaks into sibling tests / the production path.
beforeEach(() => __setLocaleForTest("en"));
afterEach(() => __setLocaleForTest(null));

describe("multi-select render + selection regression", () => {
	test("renders checkbox affordance ([ ] / Next) for a multi-select question", () => {
		const s = makeSession({});
		const body = renderBody(s);
		// checkbox markers must appear (the bug: they were absent)
		expect(body).toContain("[ ]");
		// a Next sentinel must be visible as the submit affordance
		expect(body).toContain("Next");
	});

	test("toggling flips [ ] → [✔] in the rendered output", () => {
		const s = makeSession({});
		expect(renderBody(s)).not.toContain("[✔]");
		s.component.handleInput(" "); // toggle opt0
		expect(renderBody(s)).toContain("[✔]");
		s.component.handleInput(" "); // toggle opt0 back off
		expect(renderBody(s)).not.toContain("[✔]");
	});

	test("Space opt0 → Down to Next → Enter: selection survives to the result", () => {
		const cap: { result?: QuestionnaireResult } = {};
		const s = makeSession(cap);
		s.component.handleInput(" "); // toggle opt0
		for (let i = 0; i < 5; i++) s.component.handleInput("\x1b[B"); // down to Next (idx5)
		s.component.handleInput("\r"); // Enter on Next
		expect(cap.result).toBeDefined();
		expect(cap.result!.cancelled).toBe(false);
		expect(cap.result!.answers[0]?.kind).toBe("multi");
		expect(cap.result!.answers[0]?.selected).toEqual(["Fix docs count"]);
	});

	test("hint surfaces 'Space to toggle' for multi-select questions", () => {
		const s = makeSession({});
		const out = s.component.render(120).join("\n");
		expect(out).toContain("Space to toggle");
	});
});
