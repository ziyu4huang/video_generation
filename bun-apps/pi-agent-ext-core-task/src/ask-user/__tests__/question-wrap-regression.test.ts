/**
 * Regression: a long question MUST word-wrap across multiple rendered lines
 * so the user can read the whole question.
 *
 * Root cause: DialogView.render() pushed `${header}: ${question}` as a SINGLE
 * line. When header+question exceeded the terminal width the overlay
 * truncated it, so long questions were partially hidden ("似乎不會把問題換行，
 * 導致較長的 Question 無法完整呈現"). Every other text surface (option labels,
 * descriptions, preview content, multi-select rows) already used
 * wrapTextWithAnsi — only the question header line was missed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { __setLocaleForTest } from "../state/i18n-bridge.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireSession } from "../state/questionnaire-session.js";
import { buildItemsForQuestion } from "../ask-user-question.js";
import type { QuestionParams } from "../tool/types.js";

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

const LONG_QUESTION =
	"Which authentication method do you want to use for this new project we are building together today?";

const PARAMS: QuestionParams = {
	questions: [
		{
			question: LONG_QUESTION,
			header: "Auth",
			options: [
				{ label: "OAuth 2.0", description: "x" },
				{ label: "API key", description: "y" },
			],
		},
	],
};

function makeSession(columns: number, params: QuestionParams = PARAMS) {
	const itemsByTab = params.questions.map((q) => buildItemsForQuestion(q));
	return new QuestionnaireSession({
		tui: { terminal: { columns, rows: 40 }, requestRender: () => {} },
		theme,
		params,
		itemsByTab,
		done: () => {},
		collapseKey: "off",
	});
}

// Determinism: the footer hint (t()-localized chrome) is rendered into the
// output this test scans. Pin locale=en so the render is deterministic
// regardless of ambient ~/.pi/agent/settings.json (a developer who set
// `askUserLanguage` would otherwise get translated chrome here), and restore
// the pin after so it never leaks into sibling tests / the production path.
beforeEach(() => __setLocaleForTest("en"));
afterEach(() => __setLocaleForTest(null));

describe("question wrap regression", () => {
	test("long question wraps across multiple rendered lines (not truncated)", () => {
		const WIDTH = 30;
		const s = makeSession(WIDTH);
		const lines = s.component.render(WIDTH);

		// The full question text survives in the rendered output. After
		// wrapping, fragments land on different lines, so assert each piece
		// is present rather than the original contiguous substring.
		const joined = lines.join("\n");
		expect(joined).toContain("Which authentication");
		expect(joined).toContain("method");
		expect(joined).toContain("today?");

		// The header+question is split across MORE than one line (it wraps).
		const questionLines = lines.filter(
			(l) =>
				l.includes("authentication") ||
				l.includes("method") ||
				l.includes("today"),
		);
		expect(questionLines.length).toBeGreaterThan(1);

		// No QUESTION line overflows the terminal width (the bug: the single
		// header line was ~100 cols wide). Other surfaces (footer hint, option
		// rows) are separate concerns outside this regression's scope.
		for (const line of questionLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
		}
	});

	test("short question still renders on a single header line", () => {
		const shortParams: QuestionParams = {
			questions: [
				{
					question: "Light or dark?",
					header: "Theme",
					options: [
						{ label: "Light", description: "x" },
						{ label: "Dark", description: "y" },
					],
				},
			],
		};
		const s = makeSession(120, shortParams);
		const lines = s.component.render(120);
		// header + short question appear together on the first line
		expect(lines[0]).toContain("Theme: Light or dark?");
	});
});
