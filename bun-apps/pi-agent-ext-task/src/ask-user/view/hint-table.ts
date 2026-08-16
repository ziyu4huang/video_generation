/**
 * The footer keybinding vocabulary — ONE table, rendered by ONE function.
 *
 * THE PATTERN THIS EXISTS TO BREAK
 *   `DialogView.buildHintText` used to hand-assemble the footer with a chain of
 *   `if (...) hintParts.push(...)`, while a parallel table of `HINT_PART_*` /
 *   `HINT_*_SUFFIX` constants sat beside it looking like the vocabulary. Nothing
 *   tied the two together, and four separate defects grew in the gap:
 *
 *     - the notes label was pushed as `` `n ${t(HINT_PART_NOTES)}` `` while the
 *       constant ALREADY read "n to add notes", so the footer literally printed
 *       "n n to add notes" (and "n n 新增備註" under zh-TW);
 *     - HINT_PART_COLLAPSE was defined, translated and asserted in the i18n
 *       test, but no branch ever appended it — the collapse affordance was
 *       invisible until the user had already found it;
 *     - the collapse KEY is configurable (`resolveCollapseKey`, e.g. `alt+o`)
 *       yet the hint hard-coded "Ctrl+]", so a configured key produced a footer
 *       that named the wrong key while the notify path named the right one;
 *     - HINT_SINGLE / HINT_MULTI / HINT_MULTISELECT_SUFFIX / HINT_NOTES_SUFFIX
 *       were exported and referenced by nothing. A comment in the old builder
 *       recorded that HINT_MULTISELECT_SUFFIX "existed but was never appended" —
 *       that bug was fixed by inlining the label, the constant stayed, and the
 *       identical trap was left armed for HINT_NOTES_SUFFIX.
 *
 *   All four are the same defect: a part could be DEFINED without being
 *   RENDERED, or RENDERED without going through its definition. Here a part
 *   exists only as a row in HINT_TABLE, and the only way to render one is
 *   buildHintText(), so neither half can drift from the other.
 *
 * ONE ORDER, ONE SEPARATOR
 *   Every mode renders the same table in the same order — primary action, then
 *   navigation, then per-question modifiers, then chrome, with cancel last — and
 *   joins with the same separator. The old builder had a different order on the
 *   submit tab and a different separator (" / ") in notes mode; both were
 *   accidents of hand-assembly, not decisions.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   The `n`-key gate itself. `notesAvailable` is supplied by the caller, which
 *   states the rule `state/key-router.ts` actually applies
 *   (`!multiSelect && focusedOptionHasPreview`). Whether that GATE is the right
 *   one is a separate open question — the reducer plumbs notes for multi-select
 *   answers that the gate makes unreachable
 *   (.planning/2026-08-16-power-tool-rearch/tickets/02, A2). This module reports
 *   the rule; it does not choose it.
 */
import { t } from "../state/i18n-bridge.js";

// ── The vocabulary ──────────────────────────────────────────────────────────
// Each label is the English literal AND its i18n dictionary key (see
// state/i18n-dictionaries.ts — the dictionary is keyed by the English string,
// which is what makes `en` identity for free). `{0}` is substituted by t()'s
// positional formatter with the entry's args.

export const HINT_ENTER_SELECT = "Enter to select";
export const HINT_ENTER_SUBMIT = "Enter to submit";
export const HINT_NAV = "↑/↓ to navigate";
export const HINT_TAB = "Tab to switch questions";
export const HINT_TOGGLE = "Space to toggle";
export const HINT_NOTES = "n to add notes";
export const HINT_COLLAPSE = "{0} to collapse";
export const HINT_EXPAND = "{0} to expand";
export const HINT_CANCEL = "Esc to cancel";

/** Joins the rendered parts. One separator for every mode — see header. */
export const HINT_SEPARATOR = " · ";

/**
 * Which footer the dialog is showing.
 *
 * `question` — an ordinary question tab (the only mode with per-question parts).
 * `input`    — the inline free-text row is capturing keystrokes.
 * `notes`    — the notes editor is open over the dialog.
 * `submit`   — the review/submit tab (multi-question sessions only).
 * `collapsed`— the dialog is hidden behind the one-line expand bar.
 */
export type HintMode = "question" | "input" | "notes" | "submit" | "collapsed";

export interface HintContext {
	mode: HintMode;
	/** Multi-question session: Tab switches, and a submit tab exists. */
	isMulti: boolean;
	/** The focused question takes multiple options, so Space toggles. */
	focusedIsMultiSelect: boolean;
	/** `n` would actually be accepted right now (mirrors key-router's gate). */
	notesAvailable: boolean;
	/**
	 * Display spelling of the configured collapse key (`Ctrl+]`, `Alt+O`, …), or
	 * undefined when the shortcut is off. Produced by `config.formatKeySpec` —
	 * the same resolved spec `key-router` matches against, so the hint cannot
	 * name a key the router does not honour.
	 */
	collapseKey: string | undefined;
}

interface HintEntry {
	/** English literal; doubles as the i18n dictionary key. */
	label: string;
	/** Rendered only when this holds. */
	when: (c: HintContext) => boolean;
	/** Positional args for a `{0}`-style label. */
	args?: (c: HintContext) => readonly string[];
}

/** Modes that show a live option list, so ↑/↓ moves a selection. */
const NAVIGABLE: ReadonlySet<HintMode> = new Set<HintMode>(["question", "input", "submit"]);

/** Modes where Enter commits the focused option rather than the questionnaire. */
const SELECTS_ON_ENTER: ReadonlySet<HintMode> = new Set<HintMode>(["question", "input", "notes"]);

/**
 * The whole vocabulary, in render order. Adding a hint means adding a row —
 * there is no second place to also remember to touch.
 */
export const HINT_TABLE: readonly HintEntry[] = [
	{ label: HINT_ENTER_SELECT, when: (c) => SELECTS_ON_ENTER.has(c.mode) },
	{ label: HINT_ENTER_SUBMIT, when: (c) => c.mode === "submit" },
	{ label: HINT_NAV, when: (c) => NAVIGABLE.has(c.mode) },
	{ label: HINT_TAB, when: (c) => c.isMulti && (c.mode === "question" || c.mode === "submit") },
	{ label: HINT_TOGGLE, when: (c) => c.mode === "question" && c.focusedIsMultiSelect },
	{ label: HINT_NOTES, when: (c) => c.mode === "question" && c.notesAvailable },
	// Shown on the question tab only. One place is enough to make the shortcut
	// discoverable (its absence everywhere was the bug); repeating it in every
	// mode would just lengthen footers that already wrap on narrow terminals.
	{
		label: HINT_COLLAPSE,
		when: (c) => c.mode === "question" && c.collapseKey !== undefined,
		args: (c) => [c.collapseKey ?? ""],
	},
	{
		label: HINT_EXPAND,
		when: (c) => c.mode === "collapsed" && c.collapseKey !== undefined,
		args: (c) => [c.collapseKey ?? ""],
	},
	{ label: HINT_CANCEL, when: () => true },
];

/**
 * Render one entry through t().
 *
 * The bridge disambiguates its overloads by TYPE: a string second argument is
 * the legacy `fallback`, never a format argument. So `t(label, key)` returns the
 * key alone (the label is discarded as a fallback that was never needed), and
 * `t(label)` returns the template with `{0}` still in it. A `{0}` label must
 * therefore use the full documented shape — `t(key, fallback, ...formatArgs)` —
 * passing its own literal as the fallback, which is what identity means anyway.
 */
function renderEntry(entry: HintEntry, ctx: HintContext): string {
	const args = entry.args?.(ctx);
	return args && args.length > 0 ? t(entry.label, entry.label, ...args) : t(entry.label);
}

/** Render the footer for `ctx`. PURE — no state, no theme, no terminal. */
export function buildHintText(ctx: HintContext): string {
	return HINT_TABLE.filter((e) => e.when(ctx))
		.map((e) => renderEntry(e, ctx))
		.join(HINT_SEPARATOR);
}
