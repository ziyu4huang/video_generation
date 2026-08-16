/**
 * ask_user_question chrome dictionaries (Stage 3a — i18n infrastructure).
 *
 * Design: the dictionary is KEYED BY THE ENGLISH LITERAL ITSELF. `t(key)`
 * (see i18n-bridge.ts) looks `key` up in the active locale's dictionary; if the
 * key is absent it falls back to the key unchanged. This makes the `en` locale
 * IDENTITY FOR FREE — its dictionary can be empty `{}`, because every English
 * literal is its own fallback.
 *
 * Consequence for safety: with `askUserLanguage` UNSET, the active locale is
 * `en`, so every `t()` call returns its English argument unchanged — zero
 * behavior change for existing callers. This is what lets the bridge be revived
 * (Stage 3a) BEFORE any call site is wired to `t()` (Stage 3b).
 *
 * Locale tag convention: BCP-47 (matches `askUserLanguage` in settings.json).
 * Only the tags listed in SUPPORTED_I18N_LOCALES resolve to a non-`en` dict;
 * any other tag (including ones present in settings) falls back to `en`.
 *
 * Adding a locale: append its tag to SUPPORTED_I18N_LOCALES and add a dictionary
 * entry here mapping every English chrome literal → its translation. Stage 3b
 * view wiring then needs NO dictionary edits.
 */

/** Locales with a real (non-identity) dictionary. `en` is the identity base. */
export const SUPPORTED_I18N_LOCALES = ["en", "zh-TW"] as const;

/**
 * Dictionaries keyed by locale tag → (English literal → translation).
 *
 * `en` is intentionally empty: every English literal is its own fallback, so the
 * identity behavior is obtained for free via the bridge's key-as-fallback rule.
 */
export const DICTIONARIES: Record<string, Record<string, string>> = {
	en: {},

	// ── 繁體中文 (zh-TW, Traditional Chinese — Taiwan) ───────────────────────
	// Natural UI phrasing for the ask_user_question TUI chrome. Key names
	// (Enter / Space / Tab / Esc) are kept verbatim — they are physical keys, not
	// translatable words; the REBINDABLE one is a `{0}` placeholder instead of a
	// literal. Render sites pass the EXACT English literal as the key (the
	// view/hint-table.ts HINT_* labels and dialog-builder.ts heading consts), so
	// these entries must match those strings character-for-character. The
	// coverage test in state/i18n-bridge.test.ts derives its literal list from
	// HINT_TABLE, so a new hint fails here until it is translated.
	"zh-TW": {
		// view/components/multi-select-view.ts — nextLabel default + Other-row placeholder
		Next: "下一步",
		"Type something.": "輸入內容。",

		// view/components/submit-picker.ts — Submit / Cancel row labels
		Submit: "提交",
		Cancel: "取消",

		// view/hint-table.ts — the footer keybinding vocabulary.
		// `{0}` receives a value the dictionary must not spell out itself: the
		// CONFIGURED collapse key (Ctrl+], Alt+O, …) or the `next` row's own
		// label. The English side is templated for the same reason, so neither
		// locale can hard-code something the user rebound or a rename moved.
		"Enter to select": "Enter 選取",
		"Enter to submit": "Enter 提交",
		"↑/↓ to navigate": "↑/↓ 移動",
		"Enter/Space to toggle": "Enter/Space 切換",
		// `{0}` receives the `next` sentinel's own rendered label, so this line and
		// the row it points at share the `Next` entry above.
		"{0} to confirm": "{0} 確認",
		"n to add notes": "n 新增備註",
		"Tab to switch questions": "Tab 切換問題",
		"Esc to cancel": "Esc 取消",
		"Esc to go back": "Esc 返回",
		"Esc to review answers": "Esc 檢視回答",
		"{0} to collapse": "{0} 收合",
		"{0} to expand": "{0} 展開",

		// view/dialog-builder.ts — review-tab chrome
		"Review your answers": "檢視您的回答",
		"Ready to submit your answers?": "準備提交您的回答嗎？",

		// view/dialog-builder.ts — INCOMPLETE_WARNING_PREFIX (rendered as `${prefix} ${list}`)
		"⚠ Answer remaining questions before submitting:": "⚠ 提交前請先回答剩餘的問題:",

		// Positional-formatting demonstrator — no current chrome literal uses {n};
		// included so `t("Page {0} of {1}", n, total)` is exercisable in zh-TW.
		"Page {0} of {1}": "第 {0} 頁，共 {1} 頁",
	},
};
