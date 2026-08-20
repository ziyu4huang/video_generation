/**
 * i18n bridge for ask_user_question — the single thin import surface so every
 * call site routes through one place.
 *
 * Stage 3a revival: the bridge now resolves an active locale (from
 * `askUserLanguage` in ~/.pi/agent/settings.json, overridable for tests) and
 * looks `key` up in the active locale's dictionary (see i18n-dictionaries.ts).
 * A miss falls back to the key itself — which, because the dictionary is keyed
 * by the English literal, means `en` (the default) is IDENTITY FOR FREE and the
 * `askUserLanguage`-unset path changes NO existing behavior.
 *
 * Call shapes supported (all existing call sites keep working):
 *   t(key)                          → lookup; miss ⇒ key   (new chrome style)
 *   t(key, fallback)                → lookup; miss ⇒ fallback (legacy: displayLabel / hint)
 *   t(key, ...positionalFormatArgs) → {0}/{1}… substituted after lookup
 *
 * The legacy `(key, fallback)` shape is detected when the 2nd arg is a string
 * (displayLabel passes `sentinel.<kind>` + the ROW_INTENT_META English label;
 * questionnaire-session passes `hint.expand_line` + the built collapsed hint).
 * Those namespace keys are never chrome literals, so they always miss the
 * dictionary and return the English fallback unchanged.
 *
 * CONSEQUENCE, and it bites: because the discriminator is the TYPE of the 2nd
 * arg, a STRING can never be a format arg on its own. `t("{0} to collapse",
 * "Ctrl+]")` returns "Ctrl+]" — the template is discarded as an unused fallback.
 * A chrome literal with placeholders must pass the full shape, giving its own
 * literal as the fallback: `t(label, label, ...args)`. See view/hint-table.ts.
 */

import { DICTIONARIES, SUPPORTED_I18N_LOCALES } from "./i18n-dictionaries.js";
import { ROW_INTENT_META, type SentinelKind } from "./row-intent.js";
import { getLanguageKey, readSettingsFile } from "../../response-language/settings.js";

/** Lookup function: a key plus a variable tail (legacy fallback OR format args). */
export type ScopeFn = (key: string, ...rest: unknown[]) => string;

// ── Locale resolution ───────────────────────────────────────────────────────

const DEFAULT_LOCALE = "en";

// Test seam (mirrors ask-user/config.ts `__setConfigPathForTest`): pins the
// active locale for determinism. `null` clears the pin AND invalidates the
// settings-derived cache so the next resolveActiveLocale() re-reads settings.
let __localeOverride: string | null = null;
// Per-process cache of the settings-derived locale (only the non-pinned path).
// Invalidated whenever the pin is (re)set.
let __cachedSettingsLocale: string | null = null;

/**
 * @internal test-only pin of the active locale. Pass `null` to clear the pin
 * (the next resolveActiveLocale() re-reads ~/.pi/agent/settings.json). Mirrors
 * config.ts's cache-invalidation discipline.
 */
export function __setLocaleForTest(locale: string | null): void {
	__localeOverride = locale;
	__cachedSettingsLocale = null;
}

/**
 * Resolve the active locale for chrome lookups.
 *
 * 1. If `__setLocaleForTest` pinned a locale → return it VERBATIM (even
 *    unsupported tags — t() then misses every dictionary and falls back to the
 *    English key, which is the desired "unknown locale ⇒ en identity" behavior).
 * 2. Otherwise read `askUserLanguage` from settings; a tag present in
 *    SUPPORTED_I18N_LOCALES wins, else → `en`. Cached per process (re-resolved
 *    only after the pin is touched, which clears the cache).
 */
export function resolveActiveLocale(): string {
	if (__localeOverride !== null) return __localeOverride;
	if (__cachedSettingsLocale !== null) return __cachedSettingsLocale;
	const tag = getLanguageKey(readSettingsFile(), "askUserLanguage");
	const resolved = tag && SUPPORTED_I18N_LOCALES.includes(tag as (typeof SUPPORTED_I18N_LOCALES)[number]) ? tag : DEFAULT_LOCALE;
	__cachedSettingsLocale = resolved;
	return resolved;
}

// ── Positional formatting ({0}, {1}, …) ─────────────────────────────────────

/**
 * Substitute `{0}`, `{1}`, … in `template` with the positional `args`. Only the
 * tokens present are replaced; missing indices are left as-is (no current chrome
 * literal uses placeholders, so this is forward-looking infrastructure).
 */
function formatPositions(template: string, args: readonly unknown[]): string {
	if (args.length === 0) return template;
	let out = template;
	for (let i = 0; i < args.length; i++) {
		out = out.replaceAll(`{${i}}`, String(args[i]));
	}
	return out;
}

// ── t() — the single lookup surface ─────────────────────────────────────────

/**
 * Translate `key` under the active locale.
 *
 * - If the 2nd arg is a string it is the legacy `fallback` (used by displayLabel
 *   and the collapsed-hint call); remaining args are positional format args.
 * - Otherwise every arg is a positional format arg and the fallback is `key`
 *   itself (the English-literal-as-key identity design).
 *
 * Lookup miss ⇒ the (possibly translated-then-formatted) fallback. With
 * `askUserLanguage` unset the active locale is `en` (empty dict) ⇒ every key
 * misses ⇒ the English literal/fallback is returned unchanged.
 */
export const t: ScopeFn = (key, ...rest): string => {
	const dict = DICTIONARIES[resolveActiveLocale()];
	const firstIsStringFallback = typeof rest[0] === "string";
	const fallback = firstIsStringFallback ? (rest[0] as string) : key;
	const formatArgs = firstIsStringFallback ? rest.slice(1) : rest;

	const template = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : fallback;
	return formatArgs.length > 0 ? formatPositions(template, formatArgs) : template;
};

// ── Sentinel label helper (preserved export; namespace key ⇒ English fallback) ─

/**
 * Display label for a sentinel row kind. The lookup key is the namespace id
 * `sentinel.<kind>` (NOT an English chrome literal), so it never appears in any
 * dictionary and always returns the ROW_INTENT_META English label unchanged —
 * matching the spec's "keep ROW_INTENT_META.label English" contract.
 */
export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
