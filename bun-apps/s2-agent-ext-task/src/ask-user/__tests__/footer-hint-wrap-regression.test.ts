/**
 * Regression: the footer keybinding hint MUST word-wrap across multiple
 * lines on narrow terminals so the whole hint stays visible.
 *
 * Root cause: DialogView.render() pushed buildHintText() output as a SINGLE
 * line (`theme.fg("dim", footer)`). The hint ("Enter to select · ↑/↓ to
 * navigate · … · Esc to cancel") is ~52–100 visible chars, so on a narrow
 * terminal the tail (e.g. "Esc to cancel") was truncated. Same missed-wrap
 * pattern as the question header — fixed alongside it.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __setLocaleForTest } from "../state/i18n-bridge.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireSession } from "../state/questionnaire-session.js";
import { buildItemsForQuestion } from "../ask-user-question.js";
import type { QuestionParams } from "../tool/types.js";

// Minimal theme stub. Every styling method returns its LAST string arg —
// the text being styled — so visibleWidth() is faithful (no ANSI, no color
// name prepended). theme.bold(x) -> x; theme.fg("dim", x) -> x.
const theme = new Proxy(
	{},
	{
		get:
			() =>
			(...args: unknown[]) => {
				const strs = args.filter((a): a is string => typeof a === "string");
				return strs[strs.length - 1] ?? "";
			},
	},
) as never;

const PARAMS: QuestionParams = {
	questions: [
		{
			question: "Pick one",
			header: "Choice",
			options: [
				{ label: "Alpha", description: "x" },
				{ label: "Beta", description: "y" },
			],
		},
	],
};

function makeSession(columns: number) {
	const itemsByTab = PARAMS.questions.map((q) => buildItemsForQuestion(q));
	return new QuestionnaireSession({
		tui: { terminal: { columns, rows: 40 }, requestRender: () => {} },
		theme,
		params: PARAMS,
		itemsByTab,
		done: () => {},
		collapseKey: "off",
	});
}

// Determinism: this regression asserts ENGLISH chrome footer literals ("Enter
// to select", "Esc to cancel", "navigate"). Those are t()-localized, so under a
// zh-TW locale (e.g. a developer who set `askUserLanguage`) they render as
// translated strings and the assertions break. Pin locale=en for this file so it
// is deterministic regardless of ambient ~/.pi/agent/settings.json, and restore
// the pin after so it never leaks into sibling tests / the production path.
beforeEach(() => __setLocaleForTest("en"));
afterEach(() => __setLocaleForTest(null));

describe("footer hint wrap regression", () => {
	test("long footer hint wraps across multiple lines (not truncated)", () => {
		const WIDTH = 30;
		const lines = makeSession(WIDTH).component.render(WIDTH);

		// The full hint survives in the rendered output.
		const joined = lines.join("\n");
		expect(joined).toContain("Enter to select");
		expect(joined).toContain("Esc to cancel");

		// The hint is split across MORE than one line (it wraps).
		const footerLines = lines.filter(
			(l) =>
				l.includes("Enter to select") ||
				l.includes("navigate") ||
				l.includes("Esc to cancel"),
		);
		expect(footerLines.length).toBeGreaterThan(1);

		// No footer line overflows the terminal width.
		for (const line of footerLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});
});
