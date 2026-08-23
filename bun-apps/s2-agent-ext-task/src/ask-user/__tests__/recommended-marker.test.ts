/**
 * recommended marker, CC convention — the model suffixes the label with
 * "(Recommended)"; the view renders ⭐ and strips the suffix from DISPLAY only.
 * The stored label (and therefore the answer string) keeps the suffix, matching
 * Claude Code, where the answer carries the label as authored.
 */
import { test, expect, describe } from "bun:test";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import { buildItemsForQuestion } from "../ask-user-question.js";
import { WrappingSelect } from "../view/components/wrapping-select.js";
import { RECOMMENDED_SUFFIX, type QuestionData, type QuestionParams } from "../tool/types.js";

const theme = new Proxy(
	{},
	{
		get:
			() =>
			(...args: unknown[]) =>
				args.map((a) => (typeof a === "string" ? a : "")).join(""),
	},
) as never;

function q(labels: string[]): QuestionData {
	return { question: "q?", header: "hdr", options: labels.map((l) => ({ label: l, description: "d" })) } as never;
}
function params(data: QuestionData): QuestionParams {
	return { questions: [data] } as unknown as QuestionParams;
}

describe("recommended marker (CC suffix convention)", () => {
	test("validation rejects two suffixed labels", () => {
		const r = validateQuestionnaire(params(q([`A${RECOMMENDED_SUFFIX}`, `B${RECOMMENDED_SUFFIX}`])));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("too_many_recommended");
	});

	test("buildItemsForQuestion derives recommended from the suffix", () => {
		const items = buildItemsForQuestion(q([`Alpha${RECOMMENDED_SUFFIX}`, "Beta"]));
		expect((items[0] as { recommended?: boolean }).recommended).toBe(true);
		expect((items[1] as { recommended?: boolean }).recommended).toBeUndefined();
	});

	test("WrappingSelect renders ⭐ and strips the suffix from display", () => {
		const items = buildItemsForQuestion(q([`Alpha${RECOMMENDED_SUFFIX}`, "Beta"]));
		const ws = new WrappingSelect(items, 8, theme);
		ws.setSelectedIndex(0);
		const out = ws.render(80).join("\n");
		expect(out).toContain("⭐");
		expect(out).toContain("Alpha");
		expect(out).not.toContain("(Recommended)");
		// stored label keeps the suffix → answer parity with CC
		expect(items[0].label).toBe(`Alpha${RECOMMENDED_SUFFIX}`);
	});

	test("unsuffixed options render no star", () => {
		const items = buildItemsForQuestion(q(["Alpha", "Beta"]));
		const ws = new WrappingSelect(items, 8, theme);
		ws.setSelectedIndex(0);
		expect(ws.render(80).join("\n")).not.toContain("⭐");
	});
});
