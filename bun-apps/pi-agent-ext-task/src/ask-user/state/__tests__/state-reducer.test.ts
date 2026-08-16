/**
 * Tests for the questionnaire state reducer.
 *
 * Ported from rpiv-ask-user-question state/state-reducer.test.ts (upstream).
 * Adapted from vitest to bun:test — `it` → `test`, no vi.fn()/vi.mocked().
 *
 * Tier: P0 — pure logic, no TUI deps, high regression risk.
 *
 * Covers: nav, tab_switch, confirm, toggle, multi_confirm, cancel, submit,
 *         notes_enter/exit/forward, submit_nav, ignore, toggle_collapsed.
 */
import { test, expect, describe } from "bun:test";
import type { QuestionAnswer, QuestionData } from "../../tool/types.js";
import type { QuestionnaireAction } from "../key-router.js";
import { reduce, type ApplyContext } from "../state-reducer.js";
import type { QuestionnaireState } from "../state.js";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const itemsRegular: readonly WrappingSelectItem[] = [
	{ kind: "option", label: "A" },
	{ kind: "option", label: "B" },
];

const itemsWithOther: readonly WrappingSelectItem[] = [
	{ kind: "option", label: "A" },
	{ kind: "option", label: "B" },
	{ kind: "other", label: "Type something." },
];

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "H",
		options: over.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeState(over: Partial<QuestionnaireState> = {}): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map<number, QuestionAnswer>(),
		multiSelectChecked: new Set<number>(),
		notesByTab: new Map<number, string>(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
		...over,
	};
}

function makeCtx(over: Partial<ApplyContext> = {}): ApplyContext {
	const questions = over.questions ?? [makeQuestion()];
	return {
		questions,
		itemsByTab: over.itemsByTab ?? questions.map(() => itemsRegular),
	};
}

// ─── nav ─────────────────────────────────────────────────────────────────────

describe("reduce — nav", () => {
	test("regular nav emits clear_input_buffer", () => {
		const r = reduce(makeState(), { kind: "nav", nextIndex: 1 }, makeCtx());
		expect(r.state.optionIndex).toBe(1);
		expect(r.state.inputMode).toBe(false);
		expect(r.effects).toEqual([{ kind: "clear_input_buffer" }]);
	});

	test("nav onto kind:'other' row with prior kind:'custom' answer restores the buffer", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "Pick one", kind: "custom", answer: "Hello" }],
		]);
		const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
		const r = reduce(makeState({ answers }), { kind: "nav", nextIndex: 2 }, ctx);
		expect(r.state.inputMode).toBe(true);
		expect(r.effects).toEqual([{ kind: "set_input_buffer", value: "Hello" }]);
	});

	test("nav onto kind:'other' row with no prior kind:'custom' emits no input effect", () => {
		const ctx = makeCtx({ itemsByTab: [itemsWithOther] });
		const r = reduce(makeState(), { kind: "nav", nextIndex: 2 }, ctx);
		expect(r.state.inputMode).toBe(true);
		expect(r.effects).toEqual([]);
	});
});

// ─── tab_switch ──────────────────────────────────────────────────────────────

describe("reduce — tab_switch", () => {
	test("emits set_notes_focused(false) + set_notes_value", () => {
		const r = reduce(
			makeState(),
			{ kind: "tab_switch", nextTab: 1 },
			makeCtx({ questions: [makeQuestion(), makeQuestion()], itemsByTab: [itemsRegular, itemsRegular] }),
		);
		expect(r.state.currentTab).toBe(1);
		expect(r.state.optionIndex).toBe(0);
		expect(r.state.notesVisible).toBe(false);
		expect(r.effects).toEqual([
			{ kind: "set_notes_focused", focused: false },
			{ kind: "set_notes_value", value: "" },
		]);
	});

	// ── A7 — an answered tab must show what was answered ──────────────────────
	// Multi-select ticks were already restored on tab-back; single-select answers
	// were not, and there the cursor position IS the answer.

	test("returning to a tab answered with an option puts the cursor back on that row", () => {
		const questions = [makeQuestion(), makeQuestion()];
		const answers = new Map<number, QuestionAnswer>([
			[1, { questionIndex: 1, question: "Pick one", kind: "option", answer: "B" }],
		]);
		const r = reduce(
			makeState({ answers }),
			{ kind: "tab_switch", nextTab: 1 },
			makeCtx({ questions, itemsByTab: [itemsRegular, itemsRegular] }),
		);
		expect(r.state.optionIndex).toBe(1); // itemsRegular = [A, B]
		expect(r.state.inputMode).toBe(false);
	});

	test("returning to a tab answered with free text restores the row AND seeds the shared inline Input", () => {
		const questions = [makeQuestion(), makeQuestion()];
		const answers = new Map<number, QuestionAnswer>([
			[1, { questionIndex: 1, question: "Pick one", kind: "custom", answer: "Hello" }],
		]);
		const r = reduce(
			makeState({ answers }),
			{ kind: "tab_switch", nextTab: 1 },
			makeCtx({ questions, itemsByTab: [itemsRegular, itemsWithOther] }),
		);
		expect(r.state.optionIndex).toBe(2); // itemsWithOther = [A, B, other]
		expect(r.state.inputMode).toBe(true);
		// Without the seed the row would render whatever the OTHER tab last typed —
		// there is one inline Input for the whole questionnaire.
		expect(r.effects[0]).toEqual({ kind: "set_input_buffer", value: "Hello" });
	});

	test("an answer whose label is no longer on the tab falls back to row 0 rather than a stale index", () => {
		const questions = [makeQuestion(), makeQuestion()];
		const answers = new Map<number, QuestionAnswer>([
			[1, { questionIndex: 1, question: "Pick one", kind: "option", answer: "Z" }],
		]);
		const r = reduce(
			makeState({ answers }),
			{ kind: "tab_switch", nextTab: 1 },
			makeCtx({ questions, itemsByTab: [itemsRegular, itemsRegular] }),
		);
		expect(r.state.optionIndex).toBe(0);
	});

	test("a multi-select tab stays on row 0 — its answer is the tick set, not a cursor", () => {
		const questions = [makeQuestion(), makeQuestion({ multiSelect: true })];
		const answers = new Map<number, QuestionAnswer>([
			[1, { questionIndex: 1, question: "Pick one", kind: "multi", answer: null, selected: ["B"] }],
		]);
		const r = reduce(
			makeState({ answers }),
			{ kind: "tab_switch", nextTab: 1 },
			makeCtx({ questions, itemsByTab: [itemsRegular, itemsRegular] }),
		);
		expect(r.state.optionIndex).toBe(0);
		expect([...r.state.multiSelectChecked]).toEqual([1]);
	});

	test("auto-advancing to an unanswered tab still lands on row 0 with no input effect", () => {
		const questions = [makeQuestion(), makeQuestion()];
		const ctx = makeCtx({ questions, itemsByTab: [itemsRegular, itemsWithOther] });
		const r = reduce(
			makeState(),
			{ kind: "confirm", answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" }, autoAdvanceTab: 1 },
			ctx,
		);
		expect(r.state.currentTab).toBe(1);
		expect(r.state.optionIndex).toBe(0);
		expect(r.state.inputMode).toBe(false);
		expect(r.effects.some((e) => e.kind === "set_input_buffer")).toBe(false);
	});
});

// ─── confirm ─────────────────────────────────────────────────────────────────

describe("reduce — confirm", () => {
	test("regular option without preview emits done with the answer", () => {
		const action: QuestionnaireAction = {
			kind: "confirm",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
		};
		const r = reduce(makeState(), action, makeCtx());
		expect(r.state.answers.get(0)?.answer).toBe("A");
		expect(r.effects).toEqual([{ kind: "done", result: { answers: [r.state.answers.get(0)!], cancelled: false } }]);
	});

	test("regular option matching a preview-bearing option augments answer.preview", () => {
		const questions = [
			makeQuestion({
				options: [
					{ label: "A", description: "a", preview: "code" },
					{ label: "B", description: "b" },
				],
			}),
		];
		const action: QuestionnaireAction = {
			kind: "confirm",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
		};
		const r = reduce(makeState(), action, makeCtx({ questions }));
		expect(r.state.answers.get(0)?.preview).toBe("code");
	});

	test("merges pendingNotes from notesByTab into the confirmed answer", () => {
		const action: QuestionnaireAction = {
			kind: "confirm",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
		};
		const state = makeState({ notesByTab: new Map([[0, "  side note  "]]) });
		const r = reduce(state, action, makeCtx());
		expect(r.state.answers.get(0)?.notes).toBe("  side note  ");
	});

	test("autoAdvanceTab dispatches a tab_switch result instead of done", () => {
		const action: QuestionnaireAction = {
			kind: "confirm",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
			autoAdvanceTab: 1,
		};
		const ctx = makeCtx({ questions: [makeQuestion(), makeQuestion()], itemsByTab: [itemsRegular, itemsRegular] });
		const r = reduce(makeState(), action, ctx);
		expect(r.state.currentTab).toBe(1);
		expect(r.effects.some((e) => e.kind === "set_notes_focused")).toBe(true);
		expect(r.effects.some((e) => e.kind === "done")).toBe(false);
	});
});

// ─── toggle ──────────────────────────────────────────────────────────────────

describe("reduce — toggle", () => {
	test("toggles index 0 on then off and persists into answers", () => {
		const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
		const r1 = reduce(makeState(), { kind: "toggle", index: 0 }, ctx);
		expect(r1.state.multiSelectChecked.has(0)).toBe(true);
		expect(r1.state.answers.get(0)?.selected).toEqual(["A"]);
		const r2 = reduce(r1.state, { kind: "toggle", index: 0 }, ctx);
		expect(r2.state.multiSelectChecked.has(0)).toBe(false);
		expect(r2.state.answers.has(0)).toBe(false);
	});
});

// ─── toggle → tab_switch → tab_switch round-trip (precedent f4fdd25) ────────

describe("reduce — round-trip property [toggle, tab_switch, tab_switch_back] preserves multiSelectChecked", () => {
	test("multiSelectChecked is reconstructed from answers on tab-back", () => {
		const questions = [makeQuestion({ multiSelect: true }), makeQuestion()];
		const ctx = makeCtx({ questions, itemsByTab: questions.map(() => itemsRegular) });

		let s = makeState();
		s = reduce(s, { kind: "toggle", index: 0 }, ctx).state;
		s = reduce(s, { kind: "toggle", index: 1 }, ctx).state;
		expect([...s.multiSelectChecked].sort()).toEqual([0, 1]);
		expect(s.answers.get(0)?.selected).toEqual(["A", "B"]);

		s = reduce(s, { kind: "tab_switch", nextTab: 1 }, ctx).state;
		expect([...s.multiSelectChecked]).toEqual([]);

		s = reduce(s, { kind: "tab_switch", nextTab: 0 }, ctx).state;
		expect([...s.multiSelectChecked].sort()).toEqual([0, 1]);
	});
});

// ─── multi_confirm ───────────────────────────────────────────────────────────

describe("reduce — multi_confirm", () => {
	test("persists answer + multiSelectChecked from action.selected", () => {
		const ctx = makeCtx({ questions: [makeQuestion({ multiSelect: true })] });
		const r = reduce(makeState(), { kind: "multi_confirm", selected: ["A", "B"] }, ctx);
		expect(r.state.answers.get(0)?.selected).toEqual(["A", "B"]);
		expect([...r.state.multiSelectChecked].sort()).toEqual([0, 1]);
		expect(r.effects.some((e) => e.kind === "done")).toBe(true);
	});
});

// ─── cancel / submit ─────────────────────────────────────────────────────────

describe("reduce — cancel/submit", () => {
	test("cancel emits done with cancelled: true", () => {
		const r = reduce(makeState(), { kind: "cancel" }, makeCtx());
		expect(r.effects).toEqual([{ kind: "done", result: { answers: [], cancelled: true } }]);
	});
	test("submit emits done with cancelled: false", () => {
		const r = reduce(makeState(), { kind: "submit" }, makeCtx());
		expect(r.effects).toEqual([{ kind: "done", result: { answers: [], cancelled: false } }]);
	});
});

// ─── notes_enter / notes_exit / notes_forward ────────────────────────────────

describe("reduce — notes_enter / notes_exit / notes_forward", () => {
	test("notes_enter seeds state.notesDraft from existing answer.notes and emits set_notes_value", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A", notes: "old note" }],
		]);
		const r = reduce(makeState({ answers }), { kind: "notes_enter" }, makeCtx());
		expect(r.state.notesVisible).toBe(true);
		expect(r.state.notesDraft).toBe("old note");
		expect(r.effects).toEqual([
			{ kind: "set_notes_value", value: "old note" },
			{ kind: "set_notes_focused", focused: true },
		]);
	});

	test("notes_exit with empty notesDraft clears notesByTab + strips answer.notes", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A", notes: "old note" }],
		]);
		const state = makeState({
			answers,
			notesByTab: new Map([[0, "old note"]]),
			notesVisible: true,
			notesDraft: "",
		});
		const r = reduce(state, { kind: "notes_exit" }, makeCtx());
		expect(r.state.notesVisible).toBe(false);
		expect(r.state.notesByTab.has(0)).toBe(false);
		expect(r.state.answers.get(0)?.notes).toBeUndefined();
	});

	test("notes_exit trims state.notesDraft before persisting", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A" }],
		]);
		const r = reduce(
			makeState({ answers, notesVisible: true, notesDraft: "  fresh  " }),
			{ kind: "notes_exit" },
			makeCtx(),
		);
		expect(r.state.notesByTab.get(0)).toBe("fresh");
		expect(r.state.answers.get(0)?.notes).toBe("fresh");
	});

	test("notes_exit with whitespace-only notesDraft clears notesByTab + strips answer.notes", () => {
		const answers = new Map<number, QuestionAnswer>([
			[0, { questionIndex: 0, question: "q", kind: "option", answer: "A", notes: "old note" }],
		]);
		const r = reduce(
			makeState({
				answers,
				notesByTab: new Map([[0, "old note"]]),
				notesVisible: true,
				notesDraft: "   ",
			}),
			{ kind: "notes_exit" },
			makeCtx(),
		);
		expect(r.state.notesByTab.has(0)).toBe(false);
		expect(r.state.answers.get(0)?.notes).toBeUndefined();
	});

	test("notes_forward emits a single forward_notes_keystroke effect with no state change", () => {
		const s = makeState({ notesVisible: true, notesDraft: "hel" });
		const r = reduce(s, { kind: "notes_forward", data: "l" }, makeCtx());
		expect(r.state).toBe(s);
		expect(r.effects).toEqual([{ kind: "forward_notes_keystroke", data: "l" }]);
	});
});

// ─── submit_nav / ignore ─────────────────────────────────────────────────────

describe("reduce — submit_nav / ignore", () => {
	test("submit_nav updates submitChoiceIndex with no effects", () => {
		const r = reduce(makeState(), { kind: "submit_nav", nextIndex: 1 }, makeCtx());
		expect(r.state.submitChoiceIndex).toBe(1);
		expect(r.effects).toEqual([]);
	});

	test("ignore is identity (state unchanged, no effects)", () => {
		const s = makeState({ optionIndex: 2 });
		const r = reduce(s, { kind: "ignore" }, makeCtx());
		expect(r.state).toEqual(s);
		expect(r.effects).toEqual([]);
	});
});

// ─── custom answer clears multiSelectChecked (mutual exclusivity) ────────────

describe("confirmHandler — custom answer clears multiSelectChecked (mutual exclusivity)", () => {
	const multiQ: QuestionData = {
		question: "areas?",
		header: "H",
		multiSelect: true,
		options: [
			{ label: "FE", description: "f" },
			{ label: "BE", description: "b" },
		],
	};

	test("custom confirm on a multi-select tab clears pre-existing checks", () => {
		const state = makeState({
			currentTab: 0,
			multiSelectChecked: new Set([0, 1]),
		});
		const ctx = makeCtx({ questions: [multiQ] });
		const result = reduce(
			state,
			{ kind: "confirm", answer: { questionIndex: 0, question: "areas?", kind: "custom", answer: "custom-text" } },
			ctx,
		);
		expect(result.state.multiSelectChecked.size).toBe(0);
		expect(result.state.answers.get(0)?.kind).toBe("custom");
	});

	test("option confirm on a single-select tab leaves multiSelectChecked untouched (no spurious clear)", () => {
		const singleQ: QuestionData = { question: "pick?", header: "H", options: [{ label: "A", description: "a" }] };
		const state = makeState({ currentTab: 0, multiSelectChecked: new Set([0]) });
		const ctx = makeCtx({ questions: [singleQ] });
		const result = reduce(
			state,
			{ kind: "confirm", answer: { questionIndex: 0, question: "pick?", kind: "option", answer: "A" } },
			ctx,
		);
		expect(result.state.multiSelectChecked.size).toBe(1);
	});
});

// ─── toggle_collapsed ────────────────────────────────────────────────────────

describe("reduce — toggle_collapsed", () => {
	test("flips false → true and emits set_overlay_hidden(true) so the runtime hides the overlay", () => {
		const r = reduce(makeState(), { kind: "toggle_collapsed" }, makeCtx());
		expect(r.state.collapsed).toBe(true);
		expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: true }]);
	});

	test("flips true → false (expand round-trip) and emits set_overlay_hidden(false)", () => {
		const r = reduce(makeState({ collapsed: true }), { kind: "toggle_collapsed" }, makeCtx());
		expect(r.state.collapsed).toBe(false);
		expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: false }]);
	});

	test("preserves orthogonal fields — collapse is a pure render-mode flip, never touches answers/optionIndex/notes", () => {
		// Regression guard: a future refactor that resets nav/notes on collapse would silently
		// drop the user's mid-edit work. The collapse toggle must be additive only.
		const answers = new Map<QuestionAnswer["questionIndex"], QuestionAnswer>([
			[0, { questionIndex: 0, question: "Pick one", kind: "option", answer: "A" }],
		]);
		const s = makeState({ optionIndex: 1, notesVisible: true, notesDraft: "in-flight", answers });
		const r = reduce(s, { kind: "toggle_collapsed" }, makeCtx());
		expect(r.state.collapsed).toBe(true);
		expect(r.state.optionIndex).toBe(1);
		expect(r.state.notesVisible).toBe(true);
		expect(r.state.notesDraft).toBe("in-flight");
		expect(r.state.answers).toBe(answers);
		expect(r.effects).toEqual([{ kind: "set_overlay_hidden", hidden: true }]);
	});
});
