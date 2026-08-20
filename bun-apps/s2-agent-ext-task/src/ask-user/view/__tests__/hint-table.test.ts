/**
 * Footer hint vocabulary — the four defects the table replaced, pinned.
 *
 * Each `describe` below is one finding from
 * .planning/2026-08-16-power-tool-rearch/tickets/02-ask-user-tui-review.md.
 * They shared a root cause: `buildHintText` hand-assembled the footer while a
 * parallel constant table pretended to be the vocabulary, so a part could be
 * defined without being rendered, or rendered without going through its
 * definition. The REACHABILITY suite is the structural one — it is what makes a
 * fifth instance of the same class impossible rather than merely fixed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { COLLAPSE_KEY_OFF, DEFAULT_COLLAPSE_KEY, formatKeySpec } from "../../config.js";
import { __setLocaleForTest } from "../../state/i18n-bridge.js";
import { buildItemsForQuestion } from "../../ask-user-question.js";
import { QuestionnaireSession } from "../../state/questionnaire-session.js";
import type { QuestionParams } from "../../tool/types.js";
import type { EscDestination } from "../../state/key-router.js";
import {
	buildHintText,
	HINT_BACK,
	HINT_CANCEL,
	HINT_COLLAPSE,
	HINT_EXPAND,
	HINT_NOTES,
	HINT_REVIEW,
	HINT_MULTI_CONFIRM,
	HINT_MULTI_TOGGLE,
	HINT_SEPARATOR,
	HINT_TABLE,
	type HintContext,
	type HintMode,
} from "../hint-table.js";
import { ROW_INTENT_META } from "../../state/row-intent.js";

const MODES: readonly HintMode[] = ["question", "input", "notes", "submit", "collapsed"];

const ctx = (over: Partial<HintContext> = {}): HintContext => ({
	mode: "question",
	isMulti: false,
	focusedIsMultiSelect: false,
	notesAvailable: false,
	escDestination: "cancel",
	collapseKey: "Ctrl+]",
	...over,
});

const ESC_DESTINATIONS: readonly EscDestination[] = ["cancel", "back", "review"];

/** Every context the table can be asked about (5 × 2 × 2 × 2 × 3 × 2 = 240). */
function allContexts(): HintContext[] {
	const out: HintContext[] = [];
	for (const mode of MODES) {
		for (const isMulti of [false, true]) {
			for (const focusedIsMultiSelect of [false, true]) {
				for (const notesAvailable of [false, true]) {
					for (const escDestination of ESC_DESTINATIONS) {
						for (const collapseKey of ["Ctrl+]", undefined]) {
							out.push({ mode, isMulti, focusedIsMultiSelect, notesAvailable, escDestination, collapseKey });
						}
					}
				}
			}
		}
	}
	return out;
}

beforeEach(() => __setLocaleForTest("en"));
afterEach(() => __setLocaleForTest(null));

// ── A5 (root cause) — no part can be defined without being reachable ─────────

/**
 * A label as it can appear once rendered. `{0}` stands for a value the table
 * supplies at render time — the configured collapse key, the `next` row's own
 * label — so the slot matches anything rather than one hard-coded fill. (An
 * earlier version substituted "Ctrl+]" for every `{0}`, which quietly assumed
 * the collapse key was the only templated hint there would ever be.)
 */
const labelPattern = (label: string): RegExp =>
	new RegExp(`^${label.split("{0}").map(escapeRegExp).join(".+")}$`);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("A5 — the vocabulary has no dead entries", () => {
	test("every label in HINT_TABLE is rendered by at least one context", () => {
		const rendered = [...new Set(allContexts().flatMap((c) => buildHintText(c).split(HINT_SEPARATOR)))];
		const unreachable = HINT_TABLE.map((e) => e.label).filter(
			(label) => !rendered.some((part) => labelPattern(label).test(part)),
		);
		expect(
			unreachable,
			`DEAD HINT(S): ${unreachable.join(", ")} — defined in HINT_TABLE but no context renders them. ` +
				"This is exactly how HINT_PART_COLLAPSE, HINT_SINGLE, HINT_MULTI, HINT_MULTISELECT_SUFFIX and " +
				"HINT_NOTES_SUFFIX ended up as decoration: translated, asserted, and never shown.",
		).toEqual([]);
	});

	test("no rendered part is absent from the vocabulary", () => {
		const vocabulary = HINT_TABLE.map((e) => labelPattern(e.label));
		for (const c of allContexts()) {
			for (const part of buildHintText(c).split(HINT_SEPARATOR)) {
				expect(
					vocabulary.some((re) => re.test(part)),
					`rendered part ${JSON.stringify(part)} is not a HINT_TABLE label`,
				).toBe(true);
			}
		}
	});

	test("no context renders the same part twice", () => {
		for (const c of allContexts()) {
			const parts = buildHintText(c).split(HINT_SEPARATOR);
			expect(new Set(parts).size, `duplicate part in ${JSON.stringify(c)}`).toBe(parts.length);
		}
	});

	test("every mode ends with exactly one Esc hint and uses one separator", () => {
		const escLabels = [HINT_CANCEL, HINT_BACK, HINT_REVIEW];
		for (const c of allContexts()) {
			const text = buildHintText(c);
			const shown = escLabels.filter((l) => text.split(HINT_SEPARATOR).includes(l));
			expect(shown, `${JSON.stringify(c)} showed ${shown.length} Esc hints`).toHaveLength(1);
			expect(text.endsWith(shown[0] as string), `${c.mode} does not end with its Esc hint`).toBe(true);
			expect(text).not.toContain(" / ");
		}
	});

	test("the Esc hint always names the destination the router will take", () => {
		const label: Record<EscDestination, string> = {
			cancel: HINT_CANCEL,
			back: HINT_BACK,
			review: HINT_REVIEW,
		};
		for (const c of allContexts()) {
			expect(buildHintText(c), JSON.stringify(c)).toContain(label[c.escDestination]);
		}
	});
});

// ── A1 — the notes label is rendered once, not prefixed with a stray key ─────

describe("A1 — the notes hint no longer prints its key twice", () => {
	test("renders exactly `n to add notes`", () => {
		const text = buildHintText(ctx({ notesAvailable: true }));
		expect(text).toContain(HINT_NOTES);
		expect(text).not.toContain("n n to add notes");
	});

	test("zh-TW renders the translation once, not `n n 新增備註`", () => {
		__setLocaleForTest("zh-TW");
		const text = buildHintText(ctx({ notesAvailable: true }));
		expect(text).toContain("n 新增備註");
		expect(text).not.toContain("n n 新增備註");
	});

	test("end-to-end: a live session with a preview option never doubles the key", () => {
		const params: QuestionParams = {
			questions: [
				{
					question: "Pick one",
					header: "Choice",
					options: [
						{ label: "Alpha", description: "x", preview: "some preview" },
						{ label: "Beta", description: "y" },
					],
				},
			],
		};
		const out = makeSession(params, DEFAULT_COLLAPSE_KEY).component.render(200).join("\n");
		expect(out).toContain(HINT_NOTES);
		expect(out).not.toContain("n n to add notes");
	});
});

// ── A3 — the collapse hint is actually shown ─────────────────────────────────

describe("A3 — the collapse affordance is visible before it is discovered", () => {
	test("the question footer advertises it when the shortcut is on", () => {
		expect(buildHintText(ctx())).toContain("Ctrl+] to collapse");
	});

	test("it is omitted when the shortcut is off", () => {
		const text = buildHintText(ctx({ collapseKey: undefined }));
		expect(text).not.toContain("to collapse");
	});

	test("end-to-end: a live session's footer carries it", () => {
		const params: QuestionParams = {
			questions: [{ question: "Pick one", header: "Choice", options: [{ label: "Alpha", description: "x" }] }],
		};
		const out = makeSession(params, DEFAULT_COLLAPSE_KEY).component.render(200).join("\n");
		expect(out).toContain("Ctrl+] to collapse");
	});
});

// ── A4 — one source of truth for the key's spelling ──────────────────────────

describe("A4 — the hint names the CONFIGURED key", () => {
	test("formatKeySpec leaves the default rendering byte-identical to the old literal", () => {
		expect(formatKeySpec(DEFAULT_COLLAPSE_KEY)).toBe("Ctrl+]");
		expect(buildHintText(ctx())).toContain("Ctrl+] to collapse");
	});

	test("a rebound key changes the hint (this is what the hard-coded literal could not do)", () => {
		expect(formatKeySpec("alt+o")).toBe("Alt+O");
		expect(buildHintText(ctx({ collapseKey: formatKeySpec("alt+o") }))).toContain("Alt+O to collapse");
		expect(buildHintText(ctx({ collapseKey: formatKeySpec("alt+o") }))).not.toContain("Ctrl+]");
	});

	test("the collapsed bar names the same key as the question footer", () => {
		const key = formatKeySpec("ctrl+shift+h");
		expect(key).toBe("Ctrl+Shift+H");
		expect(buildHintText(ctx({ mode: "collapsed", collapseKey: key }))).toBe(
			`Ctrl+Shift+H to expand${HINT_SEPARATOR}${HINT_CANCEL}`,
		);
	});

	test("formatKeySpec renders named and function keys readably, and `off` as undefined", () => {
		expect(formatKeySpec("ctrl+pageup")).toBe("Ctrl+PageUp");
		expect(formatKeySpec("f5")).toBe("F5");
		expect(formatKeySpec("alt+escape")).toBe("Alt+Esc");
		expect(formatKeySpec(COLLAPSE_KEY_OFF)).toBeUndefined();
	});

	test("the templated labels keep `{0}` — neither locale may hard-code a key", () => {
		expect(HINT_COLLAPSE).toContain("{0}");
		expect(HINT_EXPAND).toContain("{0}");
	});

	test("no `{0}` survives into rendered output, in either locale", () => {
		for (const locale of ["en", "zh-TW"]) {
			__setLocaleForTest(locale);
			for (const c of allContexts()) {
				expect(buildHintText(c), `${locale} / ${JSON.stringify(c)}`).not.toContain("{0}");
			}
		}
	});

	// The bridge reads a STRING second argument as the legacy `fallback`, so
	// `t("{0} to collapse", "Ctrl+]")` returns "Ctrl+]" — the label silently
	// vanishes. Pinned here because the correct call, `t(label, label, key)`,
	// looks redundant and is exactly the kind of thing a cleanup would "simplify".
	test("zh-TW substitutes the key INTO the translation, not over it", () => {
		__setLocaleForTest("zh-TW");
		expect(buildHintText(ctx({ collapseKey: "Alt+O" }))).toContain("Alt+O 收合");
		expect(buildHintText(ctx({ mode: "collapsed", collapseKey: "Alt+O" }))).toContain("Alt+O 展開");
	});
});

// ── Per-mode shape (the orderings the old hand-assembly got inconsistent) ────

describe("mode shapes", () => {
	test("question tab, single-select, no notes", () => {
		expect(buildHintText(ctx())).toBe(
			["Enter to select", "↑/↓ to navigate", "Ctrl+] to collapse", HINT_CANCEL].join(HINT_SEPARATOR),
		);
	});

	test("question tab, multi-question multi-select with notes", () => {
		expect(buildHintText(ctx({ isMulti: true, focusedIsMultiSelect: true, notesAvailable: true }))).toBe(
			[
				HINT_MULTI_TOGGLE,
				"Next to confirm",
				"↑/↓ to navigate",
				"Tab to switch questions",
				HINT_NOTES,
				"Ctrl+] to collapse",
				HINT_CANCEL,
			].join(HINT_SEPARATOR),
		);
	});

	test("submit tab says submit, not select", () => {
		const text = buildHintText(ctx({ mode: "submit", isMulti: true }));
		expect(text).toBe(
			["Enter to submit", "↑/↓ to navigate", "Tab to switch questions", HINT_CANCEL].join(HINT_SEPARATOR),
		);
		expect(text).not.toContain("Enter to select");
	});

	test("notes overlay offers only commit and cancel", () => {
		expect(buildHintText(ctx({ mode: "notes" }))).toBe(["Enter to select", HINT_CANCEL].join(HINT_SEPARATOR));
	});

	test("input mode drops Tab and the per-question modifiers", () => {
		const text = buildHintText(ctx({ mode: "input", isMulti: true, focusedIsMultiSelect: true, notesAvailable: true }));
		expect(text).toBe(["Enter to select", "↑/↓ to navigate", HINT_CANCEL].join(HINT_SEPARATOR));
	});

	// ── A9 — the footer must not claim Enter submits when it toggles ───────────

	test("a multi-select question tab offers toggle + the Next row, never `Enter to select`", () => {
		for (const c of allContexts()) {
			const text = buildHintText(c);
			const isMultiQuestion = c.mode === "question" && c.focusedIsMultiSelect;
			expect(text.includes(HINT_MULTI_TOGGLE), JSON.stringify(c)).toBe(isMultiQuestion);
			expect(text.includes("Next to confirm"), JSON.stringify(c)).toBe(isMultiQuestion);
			// "Enter to select" is what implied Enter would commit. Enter on an
			// ordinary multi-select row routes to `toggle` (key-router.ts), so the
			// two labels must never appear together.
			if (isMultiQuestion) expect(text).not.toContain("Enter to select");
		}
	});

	test("the confirm hint names the row key-router actually commits on", () => {
		// `multi_confirm` is reachable only from the row whose META says so; if that
		// row is ever renamed or another row becomes the committing one, this fails
		// instead of leaving the footer pointing at a row that no longer exists.
		expect(ROW_INTENT_META.next.autoSubmitsInMulti).toBe(true);
		expect(buildHintText(ctx({ focusedIsMultiSelect: true }))).toContain(`${ROW_INTENT_META.next.label} to confirm`);
		expect(HINT_MULTI_CONFIRM).toContain("{0}");
	});

	test("input mode on a multi-select question still says Enter selects", () => {
		// The free-text row is handled by key-router's inputMode branch, which runs
		// BEFORE the multiSelect branch — there Enter really does confirm.
		const text = buildHintText(ctx({ mode: "input", focusedIsMultiSelect: true }));
		expect(text).toContain("Enter to select");
		expect(text).not.toContain(HINT_MULTI_TOGGLE);
	});

	test("`n` is offered only when the caller says the key is accepted", () => {
		for (const c of allContexts()) {
			const offered = buildHintText(c).includes(HINT_NOTES);
			expect(offered, JSON.stringify(c)).toBe(c.mode === "question" && c.notesAvailable);
		}
	});
});

// ── helpers ─────────────────────────────────────────────────────────────────

// Minimal theme stub: every styling method returns its LAST string arg, so
// rendered output is assertion-faithful (no ANSI, no colour name leaked).
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

function makeSession(params: QuestionParams, collapseKey: string) {
	return new QuestionnaireSession({
		tui: { terminal: { columns: 200, rows: 40 }, requestRender: () => {} },
		theme,
		params,
		itemsByTab: params.questions.map((q) => buildItemsForQuestion(q)),
		done: () => {},
		collapseKey,
	});
}
