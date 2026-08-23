/** CC-parity schema — header 12, suffix-based recommended, preview single-select. */
import { test, expect, describe } from "bun:test";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import {
	MAX_HEADER_LENGTH,
	RECOMMENDED_SUFFIX,
	hasRecommendedSuffix,
	type QuestionParams,
} from "../tool/types.js";

function params(questions: unknown[]): QuestionParams {
	return { questions } as unknown as QuestionParams;
}

describe("CC parity schema", () => {
	test("header over 12 chars is rejected", () => {
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "13-char header", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("12");
	});

	test("header of exactly 12 chars passes", () => {
		// "Auth method!" is exactly 12 chars ("12 characters" in the brief is 13).
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "Auth method!", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(true);
	});

	test("label longer than 60 chars is accepted (no hard limit)", () => {
		const long = `${"word ".repeat(20)}end`;
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "hdr", options: [{ label: long, description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(true);
	});

	test("preview on a multiSelect question is rejected", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr", multiSelect: true,
				options: [
					{ label: "a", description: "d", preview: "x" },
					{ label: "b", description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("preview_on_multiselect");
	});

	test("preview on a single-select question still passes", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr",
				options: [
					{ label: "a", description: "d", preview: "x" },
					{ label: "b", description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(true);
	});

	test("more than one (Recommended)-suffixed label is rejected", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr",
				options: [
					{ label: `Alpha${RECOMMENDED_SUFFIX}`, description: "d" },
					{ label: `Beta${RECOMMENDED_SUFFIX}`, description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("too_many_recommended");
	});

	test("hasRecommendedSuffix matches only the exact CC suffix", () => {
		expect(hasRecommendedSuffix(`A${RECOMMENDED_SUFFIX}`)).toBe(true);
		expect(hasRecommendedSuffix("A (recommended)")).toBe(false);
		expect(hasRecommendedSuffix("A (Recommended) ")).toBe(false);
		expect(hasRecommendedSuffix("A")).toBe(false);
	});
});
