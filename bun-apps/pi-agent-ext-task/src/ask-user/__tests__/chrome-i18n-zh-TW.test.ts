/**
 * Chrome localization — Stage 3b render test (zh-TW).
 *
 * Proves the 15 ask-user TUI chrome literals are actually ROUTED THROUGH t()
 * at their render sites: with the locale pinned to zh-TW, the rendered output
 * must show the zh-TW translations (not the English source strings). This is
 * the GREEN gate for the wiring; before wiring it is RED (English survives).
 *
 * Coverage:
 *   - multi-select question tab: Next → 下一步, "Type something." → 輸入內容。,
 *     footer hints (Enter 選取 / Space 切換 / Esc 取消).
 *   - submit tab (reached by answering both questions in a 2-question session):
 *     REVIEW_HEADING → 檢視您的回答, READY_PROMPT → 準備提交您的回答嗎？,
 *     SubmitPicker Submit/Cancel → 提交 / 取消.
 *
 * Determinism: locale is pinned via `__setLocaleForTest` (mirrors the
 * i18n-bridge seam). afterEach restores the pin so no leak reaches sibling
 * tests or the production path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { QuestionnaireSession } from "../state/questionnaire-session.js";
import { buildItemsForQuestion } from "../ask-user-question.js";
import { __setLocaleForTest } from "../state/i18n-bridge.js";
import type { QuestionParams } from "../tool/types.js";

// Minimal theme stub: every styling method returns its LAST string arg — the
// text being styled — so rendered output is assertion-faithful (no "dim"/color
// prefix leaked, no ANSI). theme.bold(x) -> x; theme.fg("dim", x) -> x.
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

// 2-question questionnaire so isMulti=true (→ a real submit tab exists at
// tab index === questions.length). Q0 is multi-select to exercise the checkbox
// view + Next sentinel + Other free-text row + the multi-select footer hint.
const PARAMS: QuestionParams = {
	questions: [
		{
			question: "Which CI fixes?",
			header: "CI refine",
			multiSelect: true,
			options: [
				{ label: "Fix docs count", description: "x" },
				{ label: "Reusable workflow", description: "x" },
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

function makeSession() {
	const itemsByTab = PARAMS.questions.map((q) => buildItemsForQuestion(q));
	return new QuestionnaireSession({
		tui: { terminal: { columns: 120, rows: 40 }, requestRender: () => {} },
		theme,
		params: PARAMS,
		itemsByTab,
		done: () => {},
		collapseKey: "off",
	});
}

// Never leak the zh-TW pin into sibling tests / the production path.
afterEach(() => __setLocaleForTest(null));

describe("ask-user TUI chrome — zh-TW localization (Stage 3b wiring)", () => {
	test("multi-select question tab renders zh-TW chrome (Next / Type something. / footer hints)", () => {
		__setLocaleForTest("zh-TW");
		const out = makeSession().component.render(120).join("\n");

		// multi-select-view.ts render sites
		expect(out).toContain("下一步"); // Next  (nextLabel render)
		expect(out).toContain("輸入內容。"); // "Type something." (Other-row placeholder render)

		// dialog-builder.ts buildHintText render sites (multi-select branch)
		expect(out).toContain("Enter/Space 切換"); // "Enter/Space to toggle" (multiSelect)
		expect(out).toContain("下一步 確認"); // "{0} to confirm" — {0} is the SAME "Next" entry as the row above
		expect(out).not.toContain("Enter 選取"); // "Enter to select" — Enter toggles here, it does not commit
		expect(out).toContain("Esc 取消"); // "Esc to cancel"
		expect(out).toContain("↑/↓ 移動"); // "↑/↓ to navigate"
		expect(out).toContain("Tab 切換問題"); // "Tab to switch questions" (isMulti)
	});

	test("submit tab renders zh-TW chrome (review heading / ready prompt / Submit / Cancel)", () => {
		__setLocaleForTest("zh-TW");
		const s = makeSession();

		// Q0 (multi-select): toggle opt0, walk down to the Next sentinel, Enter
		// → multi_confirm auto-advances to Q1. Q0 items = [opt0,opt1,other,next]
		// so Next sits at index 3 (three ↓ from index 0).
		s.component.handleInput(" "); // toggle opt0
		for (let i = 0; i < 3; i++) s.component.handleInput("\x1b[B"); // ↓ to Next (idx3)
		s.component.handleInput("\r"); // Enter on Next → confirm Q0 → advance to Q1

		// Q1 (single-select): Enter on opt0 → confirm → auto-advance to submit tab
		s.component.handleInput("\r"); // Enter on opt0 → submit tab (idx === questions.length)

		const out = s.component.render(120).join("\n");

		// dialog-builder.ts renderSubmitBody render sites
		expect(out).toContain("檢視您的回答"); // "Review your answers"
		expect(out).toContain("準備提交您的回答嗎？"); // "Ready to submit your answers?"

		// submit-picker.ts render sites
		expect(out).toContain("提交"); // Submit
		expect(out).toContain("取消"); // Cancel

		// dialog-builder.ts buildHintText onSubmitTab branch — "Enter to submit"
		// was left raw (un-wired) by Stage 3b; Stage 3c localizes it.
		expect(out).toContain("Enter 提交"); // "Enter to submit" (submit-tab footer hint)
	});
});
