/**
 * A2 + A6, driven through a real QuestionnaireSession.
 *
 * The unit tests in state/__tests__/key-router.test.ts pin the RULES. These pin
 * the CONSEQUENCES, because both findings were about code that looked correct in
 * isolation and was unreachable or destructive in practice:
 *
 *   A2 — the reducer attached `notes` to multi-select answers in two places
 *        (persistMultiSelectAnswer, multiConfirmHandler) that the `n` gate made
 *        impossible to reach. Asserting the gate changed proves nothing; this
 *        file types a note on a multi-select question and reads it back off the
 *        submitted answer.
 *   A6 — Esc on a question tab discarded every answer with no confirmation. The
 *        test that matters is that a stray Esc mid-questionnaire no longer ends
 *        the session.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildItemsForQuestion } from "../ask-user-question.js";
import { QuestionnaireSession } from "../state/questionnaire-session.js";
import { __setLocaleForTest } from "../state/i18n-bridge.js";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.js";

// Minimal theme stub: every styling method returns its LAST string arg.
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

beforeAll(() => {
	localeDir = mkdtempSync(join(tmpdir(), "pi-ask-user-esc-"));
	prevLocaleDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = localeDir;
	__setLocaleForTest(null); // bust cache → fresh read from the empty tmp
});

afterAll(() => {
	if (prevLocaleDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevLocaleDir;
	__setLocaleForTest(null); // bust again — siblings re-read under restored env
	rmSync(localeDir, { recursive: true, force: true });
});

let localeDir: string;
let prevLocaleDir: string | undefined;
const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";

function drive(params: QuestionParams) {
	const results: QuestionnaireResult[] = [];
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: 120, rows: 40 }, requestRender: () => {} },
		theme,
		params,
		itemsByTab: params.questions.map((q) => buildItemsForQuestion(q)),
		done: (r) => results.push(r),
		collapseKey: "off",
	});
	return { session, results };
}

const TWO_QUESTIONS: QuestionParams = {
	questions: [
		{
			question: "Which fixes?",
			header: "Fixes",
			multiSelect: true,
			options: [
				{ label: "Alpha", description: "x" },
				{ label: "Beta", description: "y" },
			],
		},
		{
			question: "Deploy now?",
			header: "Deploy",
			options: [
				{ label: "Yes", description: "x" },
				{ label: "No", description: "y" },
			],
		},
	],
};

// ── A2 ──────────────────────────────────────────────────────────────────────

describe("A2 — notes reach a multi-select answer", () => {
	test("a note typed on a multi-select question survives onto the submitted answer", () => {
		const { session, results } = drive(TWO_QUESTIONS);

		// Q0 is multi-select and its options carry no preview — under the old gate
		// (`!multiSelect && focusedOptionHasPreview`) BOTH halves refused this key.
		session.component.handleInput("n");
		for (const ch of "needs a rollback plan") session.component.handleInput(ch);
		session.component.handleInput(ESC); // commit the note, close the editor

		session.component.handleInput(" "); // tick Alpha
		// items are [Alpha, Beta, Other, Next] — three ↓ lands on the Next sentinel.
		for (let i = 0; i < 3; i++) session.component.handleInput(DOWN);
		session.component.handleInput(ENTER); // confirm Q0 → auto-advance to Q1

		session.component.handleInput(ENTER); // answer Q1 → submit tab
		session.component.handleInput(ENTER); // Submit

		expect(results).toHaveLength(1);
		const q0 = results[0]?.answers.find((a) => a.questionIndex === 0);
		expect(q0?.kind).toBe("multi");
		expect(q0?.selected).toEqual(["Alpha"]);
		expect(q0?.notes).toBe("needs a rollback plan");
	});

	test("a note on a plain single-select option (no preview) also survives", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Deploy now?",
					header: "Deploy",
					options: [
						{ label: "Yes", description: "x" },
						{ label: "No", description: "y" },
					],
				},
				{ question: "Second?", header: "Second", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] },
			],
		};
		const { session, results } = drive(params);

		session.component.handleInput("n");
		for (const ch of "after the freeze") session.component.handleInput(ch);
		session.component.handleInput(ESC);
		session.component.handleInput(ENTER); // answer Q0 → advance
		session.component.handleInput(ENTER); // answer Q1 → submit tab
		session.component.handleInput(ENTER); // Submit

		const q0 = results[0]?.answers.find((a) => a.questionIndex === 0);
		expect(q0?.answer).toBe("Yes");
		expect(q0?.notes).toBe("after the freeze");
	});
});

// ── A6 ──────────────────────────────────────────────────────────────────────

describe("A6 — a stray Esc no longer throws away the questionnaire", () => {
	test("Esc after answering one question lands on the submit tab, session still open", () => {
		const { session, results } = drive(TWO_QUESTIONS);

		session.component.handleInput(" "); // tick Alpha on Q0
		for (let i = 0; i < 3; i++) session.component.handleInput(DOWN);
		session.component.handleInput(ENTER); // confirm Q0 → now on Q1, one answer banked

		session.component.handleInput(ESC); // the stray keystroke

		expect(results, "Esc ended the session — the A6 regression is back").toHaveLength(0);
		expect(session.component.render(120).join("\n")).toContain("Ready to submit your answers?");
	});

	test("Esc Esc still quits, and reports cancelled", () => {
		const { session, results } = drive(TWO_QUESTIONS);

		session.component.handleInput(" ");
		for (let i = 0; i < 3; i++) session.component.handleInput(DOWN);
		session.component.handleInput(ENTER);

		session.component.handleInput(ESC); // → submit tab
		session.component.handleInput(ESC); // → cancel

		expect(results).toHaveLength(1);
		expect(results[0]?.cancelled).toBe(true);
	});

	test("Esc with nothing answered still quits in one keystroke", () => {
		const { session, results } = drive(TWO_QUESTIONS);
		session.component.handleInput(ESC);
		expect(results).toHaveLength(1);
		expect(results[0]?.cancelled).toBe(true);
	});

	test("the footer names the destination Esc will actually take", () => {
		const { session } = drive(TWO_QUESTIONS);
		expect(session.component.render(200).join("\n")).toContain("Esc to cancel");

		session.component.handleInput(" ");
		for (let i = 0; i < 3; i++) session.component.handleInput(DOWN);
		session.component.handleInput(ENTER); // one answer banked, now on Q1

		expect(session.component.render(200).join("\n")).toContain("Esc to review answers");
	});
});
