/**
 * i18n bridge for ask_user_question — single thin import surface so every
 * call site routes through one place.
 *
 * Stripped of @juicesharp/rpiv-i18n entirely. All labels are inline English
 * literals (same fallback the rpiv version used when the i18n SDK was absent).
 * No locale switching, no registration, no dynamic imports.
 */

import { ROW_INTENT_META, type SentinelKind } from "./row-intent.js";

export const I18N_NAMESPACE = "@juicesharp/rpiv-ask-user-question";

type ScopeFn = (key: string, fallback: string) => string;

// Identity passthrough — always returns the inline English fallback
const identityScope: ScopeFn = (_key, fallback) => fallback;

export const t: ScopeFn = identityScope;

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
