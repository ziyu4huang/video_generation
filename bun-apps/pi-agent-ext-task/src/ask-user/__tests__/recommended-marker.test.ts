/**
 * recommended-marker — the stable recommendation style for ask_user_question.
 *
 * A `recommended?: boolean` field on options is rendered by the view as a ⭐
 * prefix on the option title (display-only). The stored label stays clean so
 * the answer string never carries the marker. At most one recommended option
 * per question is allowed (validated).
 */
import { test, expect, describe } from "bun:test";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import { buildItemsForQuestion } from "../ask-user-question.js";
import { WrappingSelect } from "../view/components/wrapping-select.js";
import type { QuestionData, QuestionParams } from "../tool/types.js";

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

function q(
	opts: Array<{ label: string; description?: string; recommended?: boolean }>,
): QuestionData {
	return { question: "q?", header: "hdr", options: opts as never } as never;
}

function params(data: QuestionData): QuestionParams {
	return { questions: [data] } as unknown as QuestionParams;
}

describe("recommended marker", () => {
	test("validation rejects more than one recommended option per question", () => {
		const r = validateQuestionnaire(
			params(
				q([
					{ label: "a", description: "d", recommended: true },
					{ label: "b", description: "d", recommended: true },
				]),
			),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("too_many_recommended");
	});

	test("validation accepts at most one recommended option", () => {
		const r = validateQuestionnaire(
			params(
				q([
					{ label: "a", description: "d", recommended: true },
					{ label: "b", description: "d" },
				]),
			),
		);
		expect(r.ok).toBe(true);
	});

	test("buildItemsForQuestion carries recommended onto the option item", () => {
		const items = buildItemsForQuestion(
			q([
				{ label: "Alpha", description: "d", recommended: true },
				{ label: "Beta", description: "d" },
			]),
		);
		expect((items[0] as { recommended?: boolean }).recommended).toBe(true);
		expect((items[1] as { recommended?: boolean }).recommended).toBeUndefined();
	});

	test("WrappingSelect renders a ⭐ prefix on the recommended option (display-only)", () => {
		const items = buildItemsForQuestion(
			q([
				{ label: "Alpha", description: "d", recommended: true },
				{ label: "Beta", description: "d" },
			]),
		);
		const ws = new WrappingSelect(items, 8, theme);
		ws.setSelectedIndex(0);
		const out = ws.render(80).join("\n");
		expect(out).toContain("⭐");
		expect(out).toContain("Alpha");
		// stored label stays clean → the answer string stays clean
		expect(items[0].label).toBe("Alpha");
	});

	test("non-recommended options render no star", () => {
		const items = buildItemsForQuestion(
			q([
				{ label: "Alpha", description: "d" },
				{ label: "Beta", description: "d" },
			]),
		);
		const ws = new WrappingSelect(items, 8, theme);
		ws.setSelectedIndex(0);
		expect(ws.render(80).join("\n")).not.toContain("⭐");
	});
});
