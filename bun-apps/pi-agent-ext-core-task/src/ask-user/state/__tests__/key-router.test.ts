/**
 * Tests for the keystroke router — maps raw terminal input → QuestionnaireAction.
 *
 * Ported from rpiv-ask-user-question state/key-router.test.ts (upstream).
 * Adapted from vitest to bun:test.
 *
 * Tier: P0 — pure logic, no TUI deps, high regression risk.
 *
 * Covers: wrapTab, allAnswered, nav (UP/DOWN), tab_switch (Tab/Shift+Tab/Left/Right),
 *         confirm (single-select), multiSelect (Space/Enter/Next), free-text
 *         ("Type something."), cancel + submit, notes ('n' key), inputMode,
 *         collapse/expand (Ctrl+]), collapsed-mode lockout.
 */
import { test, expect, describe } from "bun:test";
import type { QuestionAnswer, QuestionData } from "../../tool/types.js";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.js";
import { allAnswered, escDestination, notesKeyAccepted, routeKey, wrapTab } from "../key-router.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "../state.js";

// ─── Keybinding helpers ─────────────────────────────────────────────────────

const KEY = {
	UP: "tui.select.up",
	DOWN: "tui.select.down",
	CONFIRM: "tui.select.confirm",
	CANCEL: "tui.select.cancel",
};
const sentinel = (name: string) => `<KEY:${name}>`;
const keybindings = { matches: (data: string, name: string) => data === sentinel(name) };

const BYTE_TAB = "\t";
const BYTE_SHIFT_TAB = "\x1b[Z";
const BYTE_RIGHT = "\x1b[C";
const BYTE_LEFT = "\x1b[D";
const BYTE_SPACE = " ";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "H",
		options: over.options ?? [
			{ label: "A", description: "a" },
			{ label: "B", description: "b" },
			{ label: "C", description: "c" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeAnswer(over: Partial<QuestionAnswer> = {}): QuestionAnswer {
	return {
		questionIndex: over.questionIndex ?? 0,
		question: over.question ?? "q",
		kind: over.kind ?? "option",
		answer: over.answer ?? "A",
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

function makeRuntime(over: Partial<QuestionnaireRuntime> = {}): QuestionnaireRuntime {
	const questions = over.questions ?? [makeQuestion(), makeQuestion()];
	const items: WrappingSelectItem[] = over.items
		? [...over.items]
		: questions[0]!.options.map((o) => ({ kind: "option" as const, label: o.label }));
	return {
		keybindings,
		inputBuffer: "",
		questions,
		isMulti: questions.length > 1,
		currentItem: items[0],
		items,
		collapseKey: "ctrl+]",
		...over,
	};
}

// ─── wrapTab + allAnswered ───────────────────────────────────────────────────

describe("wrapTab + allAnswered", () => {
	test("wraps negative + over-max into [0, total)", () => {
		expect(wrapTab(-1, 3)).toBe(2);
		expect(wrapTab(3, 3)).toBe(0);
		expect(wrapTab(0, 0)).toBe(0);
	});

	test("allAnswered is false when any question lacks an answer", () => {
		expect(allAnswered(makeState({ answers: new Map([[0, makeAnswer({ questionIndex: 0 })]] ) }), makeRuntime())).toBe(false);
	});

	test("allAnswered is true when every question has an answer", () => {
		expect(
			allAnswered(
				makeState({
					answers: new Map([
						[0, makeAnswer({ questionIndex: 0 })],
						[1, makeAnswer({ questionIndex: 1 })],
					]),
				}),
				makeRuntime(),
			),
		).toBe(true);
	});
});

// ─── nav ─────────────────────────────────────────────────────────────────────

describe("routeKey — nav", () => {
	test("UP from a non-zero index decrements by 1", () => {
		expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 1,
		});
	});
	test("DOWN advances by 1", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState(), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 1,
		});
	});
	test("DOWN at the last item wraps to 0 (no chat row, wrapTab clamp)", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState({ optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "nav",
			nextIndex: 0,
		});
	});
	test("UP at the first item wraps to the last (no chat row, wrapTab clamp)", () => {
		const runtime = makeRuntime();
		const last = runtime.items.length - 1;
		expect(routeKey(sentinel(KEY.UP), makeState({ optionIndex: 0 }), runtime)).toEqual({
			kind: "nav",
			nextIndex: last,
		});
	});
});

// ─── tab_switch ──────────────────────────────────────────────────────────────

describe("routeKey — tab_switch", () => {
	test("Tab cycles forward through total tabs (questions + Submit)", () => {
		expect(routeKey(BYTE_TAB, makeState(), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 1,
		});
	});

	test("Right is an alias for Tab", () => {
		expect(routeKey(BYTE_RIGHT, makeState(), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 1,
		});
	});

	test("Shift+Tab wraps backward from tab 0 to the Submit tab", () => {
		expect(routeKey(BYTE_SHIFT_TAB, makeState({ currentTab: 0 }), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 2,
		});
	});

	test("Left is an alias for Shift+Tab", () => {
		expect(routeKey(BYTE_LEFT, makeState({ currentTab: 1 }), makeRuntime())).toEqual({
			kind: "tab_switch",
			nextTab: 0,
		});
	});

	test("Tab is a no-op (returns ignore) in single-question mode", () => {
		expect(routeKey(BYTE_TAB, makeState(), makeRuntime({ isMulti: false, questions: [makeQuestion()] }))).toEqual({
			kind: "ignore",
		});
	});
});

// ─── confirm (single-select) ─────────────────────────────────────────────────

describe("routeKey — confirm (single-select)", () => {
	test("emits confirm with autoAdvanceTab pointing to the next tab", () => {
		const action = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 0 }), makeRuntime());
		expect(action).toMatchObject({
			kind: "confirm",
			answer: { questionIndex: 0, answer: "A", kind: "option" },
			autoAdvanceTab: 1,
		});
	});

	test("last question -> autoAdvanceTab points at the Submit tab (questions.length)", () => {
		const action = routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 1 }), makeRuntime());
		expect(action).toMatchObject({ kind: "confirm", autoAdvanceTab: 2 });
	});

	test("single-question (!isMulti) -> autoAdvanceTab is undefined (dialog submits)", () => {
		const questions = [makeQuestion()];
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState(),
			makeRuntime({
				isMulti: false,
				questions,
				items: [
					{ kind: "option", label: "A" },
					{ kind: "option", label: "B" },
					{ kind: "option", label: "C" },
				],
			}),
		);
		expect(action).toMatchObject({ kind: "confirm" });
		if (action.kind === "confirm") {
			expect(action.autoAdvanceTab).toBeUndefined();
		}
	});

	test("inline-input mode: Enter confirms with the buffered text + kind:'custom'", () => {
		const other: WrappingSelectItem = { kind: "other", label: "Type something." };
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ inputMode: true }),
			makeRuntime({ currentItem: other, inputBuffer: "my custom answer" }),
		);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.answer).toBe("my custom answer");
			expect(action.answer.kind).toBe("custom");
		}
	});
});

// ─── multiSelect ─────────────────────────────────────────────────────────────

describe("routeKey — multiSelect", () => {
	const multiQ = makeQuestion({
		multiSelect: true,
		options: [
			{ label: "FE", description: "FE" },
			{ label: "BE", description: "BE" },
			{ label: "Tests", description: "T" },
		],
	});

	test("Space emits toggle for the current optionIndex", () => {
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ optionIndex: 1 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
					],
					currentItem: { kind: "option", label: "BE" },
				}),
			),
		).toEqual({ kind: "toggle", index: 1 });
	});

	test("Enter on a regular row emits toggle for the current optionIndex", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ optionIndex: 1 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "option", label: "BE" },
				}),
			),
		).toEqual({ kind: "toggle", index: 1 });
	});

	test("Space on Next sentinel is ignored", () => {
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ optionIndex: 3 }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "next", label: "Next" },
				}),
			),
		).toEqual({ kind: "ignore" });
	});

	test("Enter on Next emits multi_confirm with selected labels in option order", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ optionIndex: 3, multiSelectChecked: new Set([2, 0]) }),
				makeRuntime({
					questions: [multiQ],
					isMulti: false,
					items: [
						{ kind: "option", label: "FE" },
						{ kind: "option", label: "BE" },
						{ kind: "option", label: "Tests" },
						{ kind: "next", label: "Next" },
					],
					currentItem: { kind: "next", label: "Next" },
				}),
			),
		).toEqual({
			kind: "multi_confirm",
			selected: ["FE", "Tests"],
			autoAdvanceTab: undefined,
		});
	});

	test("single-question multi-select: Enter on Next carries autoAdvanceTab=undefined (host → submit)", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ optionIndex: 3, multiSelectChecked: new Set([0]) }),
			makeRuntime({
				questions: [multiQ],
				isMulti: false,
				items: [
					{ kind: "option", label: "FE" },
					{ kind: "option", label: "BE" },
					{ kind: "option", label: "Tests" },
					{ kind: "next", label: "Next" },
				],
				currentItem: { kind: "next", label: "Next" },
			}),
		);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBeUndefined();
	});

	test("multi-question multi-select on tab 0: Enter on Next carries autoAdvanceTab=1", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ currentTab: 0, optionIndex: 3, multiSelectChecked: new Set([0]) }),
			makeRuntime({
				questions: [multiQ, makeQuestion()],
				isMulti: true,
				items: [
					{ kind: "option", label: "FE" },
					{ kind: "option", label: "BE" },
					{ kind: "option", label: "Tests" },
					{ kind: "next", label: "Next" },
				],
				currentItem: { kind: "next", label: "Next" },
			}),
		);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBe(1);
	});

	test("multi-question multi-select on last tab: Enter on Next carries autoAdvanceTab=questions.length (Submit)", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ currentTab: 1, optionIndex: 3, multiSelectChecked: new Set([0]) }),
			makeRuntime({
				questions: [makeQuestion(), multiQ],
				isMulti: true,
				items: [
					{ kind: "option", label: "FE" },
					{ kind: "option", label: "BE" },
					{ kind: "option", label: "Tests" },
					{ kind: "next", label: "Next" },
				],
				currentItem: { kind: "next", label: "Next" },
			}),
		);
		expect(action.kind).toBe("multi_confirm");
		if (action.kind === "multi_confirm") expect(action.autoAdvanceTab).toBe(2);
	});

	test("Space does NOT emit toggle on a single-select question", () => {
		expect(routeKey(BYTE_SPACE, makeState(), makeRuntime())).toEqual({ kind: "ignore" });
	});
});

// ─── multiSelect free-text ('Type something.') ───────────────────────────────

describe("routeKey — multiSelect free-text ('Type something.')", () => {
	const multiQ = makeQuestion({
		multiSelect: true,
		options: [
			{ label: "FE", description: "FE" },
			{ label: "BE", description: "BE" },
			{ label: "Tests", description: "T" },
		],
	});
	const items: WrappingSelectItem[] = [
		{ kind: "option", label: "FE" },
		{ kind: "option", label: "BE" },
		{ kind: "option", label: "Tests" },
		{ kind: "other", label: "Type something." },
		{ kind: "next", label: "Next" },
	];

	test("Enter on the 'Type something.' row (inputMode) → confirm kind:'custom' with the buffer", () => {
		const action = routeKey(
			sentinel(KEY.CONFIRM),
			makeState({ optionIndex: 3, inputMode: true }),
			makeRuntime({
				questions: [multiQ],
				isMulti: false,
				items,
				currentItem: items[3],
				inputBuffer: "typed answer",
			}),
		);
		expect(action.kind).toBe("confirm");
		if (action.kind === "confirm") {
			expect(action.answer.kind).toBe("custom");
			expect(action.answer.answer).toBe("typed answer");
		}
	});

	test("Space on the 'Type something.' row (defensive, !inputMode) → ignore (no phantom toggle)", () => {
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "ignore" });
	});

	test("Enter on the 'Type something.' row (defensive, !inputMode) → ignore (no toggle/multi_confirm)", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "ignore" });
	});

	test("DOWN from last option (index 2) → nav to the other row (index 3)", () => {
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ optionIndex: 2 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[2] }),
			),
		).toEqual({ kind: "nav", nextIndex: 3 });
	});

	test("DOWN from the other row (index 3) → nav to Next (index 4)", () => {
		expect(
			routeKey(
				sentinel(KEY.DOWN),
				makeState({ optionIndex: 3 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[3] }),
			),
		).toEqual({ kind: "nav", nextIndex: 4 });
	});

	test("UP from Next (index 4) → nav back to the other row (index 3)", () => {
		expect(
			routeKey(
				sentinel(KEY.UP),
				makeState({ optionIndex: 4 }),
				makeRuntime({ questions: [multiQ], isMulti: false, items, currentItem: items[4] }),
			),
		).toEqual({ kind: "nav", nextIndex: 3 });
	});
});

// ─── cancel + submit ─────────────────────────────────────────────────────────

describe("routeKey — cancel + submit", () => {
	test("Esc cancels the entire questionnaire from any tab", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState(), makeRuntime())).toEqual({ kind: "cancel" });
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ currentTab: 2 }), makeRuntime())).toEqual({
			kind: "cancel",
		});
	});

	test("Submit tab + Enter on Submit row + allAnswered -> submit", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({
					currentTab: 2,
					submitChoiceIndex: 0,
					answers: new Map([
						[0, makeAnswer({ questionIndex: 0 })],
						[1, makeAnswer({ questionIndex: 1 })],
					]),
				}),
				makeRuntime(),
			),
		).toEqual({ kind: "submit" });
	});

	test("Submit tab + Enter on Submit row when not allAnswered -> submit (partial)", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({
					currentTab: 2,
					submitChoiceIndex: 0,
					answers: new Map([[0, makeAnswer({ questionIndex: 0 })]]),
				}),
				makeRuntime(),
			),
		).toEqual({ kind: "submit" });
	});

	test("Submit tab + DOWN -> submit_nav nextIndex=1", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState({ currentTab: 2, submitChoiceIndex: 0 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 1,
		});
	});

	test("Submit tab + UP wraps from 0 to 1", () => {
		expect(routeKey(sentinel(KEY.UP), makeState({ currentTab: 2, submitChoiceIndex: 0 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 1,
		});
	});

	test("Submit tab + DOWN from index 1 wraps to 0", () => {
		expect(routeKey(sentinel(KEY.DOWN), makeState({ currentTab: 2, submitChoiceIndex: 1 }), makeRuntime())).toEqual({
			kind: "submit_nav",
			nextIndex: 0,
		});
	});

	test("Submit tab + Enter on Cancel row (index 1) when complete -> cancel", () => {
		expect(
			routeKey(
				sentinel(KEY.CONFIRM),
				makeState({
					currentTab: 2,
					submitChoiceIndex: 1,
					answers: new Map([
						[0, makeAnswer({ questionIndex: 0 })],
						[1, makeAnswer({ questionIndex: 1 })],
					]),
				}),
				makeRuntime(),
			),
		).toEqual({ kind: "cancel" });
	});

	test("Submit tab + Enter on Cancel row (index 1) when incomplete -> cancel", () => {
		expect(
			routeKey(sentinel(KEY.CONFIRM), makeState({ currentTab: 2, submitChoiceIndex: 1 }), makeRuntime()),
		).toEqual({ kind: "cancel" });
	});
});

// ─── notes ───────────────────────────────────────────────────────────────────

describe("routeKey — notes", () => {
	test("'n' when focused option has preview emits notes_enter", () => {
		expect(routeKey("n", makeState({ focusedOptionHasPreview: true }), makeRuntime())).toEqual({
			kind: "notes_enter",
		});
	});

	// A2: `n` used to be gated on `!multiSelect && focusedOptionHasPreview`. The
	// preview half was arbitrary (annotating a plain option is a fair thing to
	// want) and the multiSelect half made the reducer's multi notes branches
	// permanently unreachable. Both are gone; notes work on any question tab.
	test("'n' works with no preview on the focused option", () => {
		expect(routeKey("n", makeState({ focusedOptionHasPreview: false }), makeRuntime())).toEqual({
			kind: "notes_enter",
		});
	});

	test("'n' works on multiSelect questions — this is what unblocked the reducer's multi notes paths", () => {
		const multiQ = makeQuestion({ multiSelect: true });
		expect(
			routeKey(
				"n",
				makeState({ focusedOptionHasPreview: false }),
				makeRuntime({ questions: [multiQ, makeQuestion()] }),
			),
		).toEqual({ kind: "notes_enter" });
	});

	test("'n' is refused where there is no question to annotate (submit tab)", () => {
		const runtime = makeRuntime({ questions: [makeQuestion(), makeQuestion()] });
		expect(routeKey("n", makeState({ currentTab: 2 }), runtime)).toEqual({ kind: "ignore" });
	});

	test("notesKeyAccepted is the ONE rule — the router and the footer both read it", () => {
		const ctx = { isMulti: true, questionCount: 2 };
		expect(notesKeyAccepted(makeState(), ctx)).toBe(true);
		expect(notesKeyAccepted(makeState({ currentTab: 2 }), ctx)).toBe(false); // submit tab
		expect(notesKeyAccepted(makeState({ notesVisible: true }), ctx)).toBe(false);
		expect(notesKeyAccepted(makeState({ inputMode: true }), ctx)).toBe(false);
		expect(notesKeyAccepted(makeState({ collapsed: true }), ctx)).toBe(false);
	});

	test("notesMode: Esc -> notes_exit", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_exit",
		});
	});

	test("notesMode: Enter -> notes_exit (save + return to options)", () => {
		expect(routeKey(sentinel(KEY.CONFIRM), makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_exit",
		});
	});

	test("notesMode: Tab byte emits notes_forward (any non-Esc/Enter key forwards to the Input)", () => {
		expect(routeKey(BYTE_TAB, makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_forward",
			data: BYTE_TAB,
		});
	});

	test("notesMode: arbitrary printable byte emits notes_forward (single dispatch path)", () => {
		expect(routeKey("a", makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "notes_forward",
			data: "a",
		});
	});
});

// ─── inputMode (Type something) ──────────────────────────────────────────────

describe("routeKey — inputMode (Type something)", () => {
	const other: WrappingSelectItem = { kind: "other", label: "Type something." };

	test("Tab byte is ignored under inputMode", () => {
		expect(routeKey(BYTE_TAB, makeState({ inputMode: true }), makeRuntime({ currentItem: other }))).toEqual({
			kind: "ignore",
		});
	});

	test("printable bytes return ignore (dialog forwards to inlineInput.handleInput)", () => {
		expect(routeKey("x", makeState({ inputMode: true }), makeRuntime({ currentItem: other }))).toEqual({
			kind: "ignore",
		});
	});

	// A6: Esc in inputMode used to destroy the whole questionnaire. Input mode is
	// a property of the FOCUSED ROW, so leaving the free-text field means moving
	// off it — navHandler then clears inputMode and the buffer. Questions always
	// carry real option rows above the free-text one, so there is somewhere to go.
	test("Esc leaves the free-text row instead of cancelling the questionnaire", () => {
		const runtime = makeRuntime({ currentItem: other, items: [{ kind: "option", label: "A" }, other] });
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ inputMode: true, optionIndex: 1 }), runtime)).toEqual({
			kind: "nav",
			nextIndex: 0,
		});
	});
});

// ─── A6: Esc is no longer a single destructive verb ──────────────────────────

describe("escDestination — Esc stops discarding answers without confirmation", () => {
	const multi = { isMulti: true, questionCount: 3 };
	const single = { isMulti: false, questionCount: 1 };
	const answered = (n: number) =>
		new Map(
			Array.from({ length: n }, (_, i) => [
				i,
				{ questionIndex: i, question: "q", kind: "option" as const, answer: "A" },
			]),
		);

	test("a question tab with answers routes to the submit tab, not to oblivion", () => {
		expect(escDestination(makeState({ answers: answered(1) }), multi)).toBe("review");
		const runtime = makeRuntime({ questions: [makeQuestion(), makeQuestion(), makeQuestion()] });
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ answers: answered(1) }), runtime)).toEqual({
			kind: "tab_switch",
			nextTab: 3,
		});
	});

	test("Esc Esc still quits — the submit tab IS the deliberate exit", () => {
		expect(escDestination(makeState({ answers: answered(1), currentTab: 3 }), multi)).toBe("cancel");
	});

	test("a question tab with nothing answered still cancels outright", () => {
		expect(escDestination(makeState(), multi)).toBe("cancel");
	});

	test("single-question sessions are unchanged (answering one completes the dialog)", () => {
		expect(escDestination(makeState(), single)).toBe("cancel");
		expect(escDestination(makeState({ answers: answered(1) }), single)).toBe("cancel");
	});

	test("open overlays go back, not away", () => {
		expect(escDestination(makeState({ notesVisible: true }), multi)).toBe("back");
		expect(escDestination(makeState({ inputMode: true }), multi)).toBe("back");
	});

	test("the collapsed bar dismisses — the dialog is already out of the way", () => {
		expect(escDestination(makeState({ collapsed: true, answers: answered(2) }), multi)).toBe("cancel");
	});
});

// ─── collapse/expand (Ctrl+] toggle + collapsed-mode lockout) ────────────────

describe("routeKey — collapse/expand (Ctrl+] toggle + collapsed-mode lockout)", () => {
	const BYTE_CTRL_RBRACKET = "\x1d";

	test("Ctrl+] emits toggle_collapsed from the default question state", () => {
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), makeRuntime())).toEqual({ kind: "toggle_collapsed" });
	});

	test("Ctrl+] emits toggle_collapsed even while notesVisible (the notes branch never sees the key)", () => {
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState({ notesVisible: true }), makeRuntime())).toEqual({
			kind: "toggle_collapsed",
		});
	});

	test("Ctrl+] emits toggle_collapsed even when already collapsed (expand round-trip)", () => {
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState({ collapsed: true }), makeRuntime())).toEqual({
			kind: "toggle_collapsed",
		});
	});

	test("while collapsed, Esc maps to cancel (the documented escape hatch in the one-line footer)", () => {
		expect(routeKey(sentinel(KEY.CANCEL), makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "cancel" });
	});

	test("while collapsed, navigation keys are swallowed as ignore (no state mutation behind the one-line footer)", () => {
		expect(routeKey(sentinel(KEY.UP), makeState({ collapsed: true, optionIndex: 2 }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(routeKey(sentinel(KEY.DOWN), makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "ignore" });
		expect(routeKey(sentinel(KEY.CONFIRM), makeState({ collapsed: true }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(routeKey(BYTE_TAB, makeState({ collapsed: true }), makeRuntime())).toEqual({ kind: "ignore" });
	});

	test("while collapsed, the notes-forward and toggle branches are unreachable (lockout precedes them)", () => {
		expect(routeKey("x", makeState({ collapsed: true, notesVisible: true }), makeRuntime())).toEqual({
			kind: "ignore",
		});
		expect(
			routeKey(
				BYTE_SPACE,
				makeState({ collapsed: true }),
				makeRuntime({ questions: [makeQuestion({ multiSelect: true })] }),
			),
		).toEqual({ kind: "ignore" });
	});

	test("uses the runtime's collapseKey for the toggle (default `ctrl+]`, configurable for non-US layouts)", () => {
		const BYTE_ALT_O = "\x1bo";
		expect(routeKey(BYTE_ALT_O, makeState(), makeRuntime({ collapseKey: "alt+o" }))).toEqual({
			kind: "toggle_collapsed",
		});
		expect(routeKey("\x1d", makeState(), makeRuntime({ collapseKey: "alt+o" }))).toEqual({ kind: "ignore" });
	});
	test("`collapseKey: 'off'` disables the toggle entirely (the key is never matched)", () => {
		const runtime = makeRuntime({ collapseKey: "off" });
		expect(routeKey(BYTE_CTRL_RBRACKET, makeState(), runtime)).not.toEqual({ kind: "toggle_collapsed" });
	});
});
