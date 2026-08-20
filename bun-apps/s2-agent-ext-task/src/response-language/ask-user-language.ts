/**
 * ask-user-language — registers the `/ask-user-language` slash command for live
 * control of the ask_user_question TUI language. Mirrors /response-language
 * but writes the INDEPENDENT `askUserLanguage` key in ~/.pi/agent/settings.json.
 *
 * Setting `askUserLanguage` STRICTLY fixes the language of ask_user_question —
 * both model-authored CONTENT (question, header, option labels, descriptions,
 * previews) and the TUI CHROME — OVERRIDING `responseLanguage` for
 * ask_user_question only; conversation replies still follow `responseLanguage`.
 * When `askUserLanguage` is UNSET, content falls back to `responseLanguage`
 * steering and chrome falls back to English (the status quo).
 *
 * Reuses command.ts's pure `decideCommand` / `parseLanguageArg` verbatim — they
 * are key-agnostic. Writes via the generic `writeLanguageKey`; reads via the
 * generic `getLanguageKey`. Both live in settings.ts alongside the response-
 * language equivalents.
 *
 * The forced content injection itself is applied by the `force-response-language`
 * patch in `bun-apps/s2-agent/src/patches/` (Stage 1: it emits an
 * `<ask_user_language>` block reading this key fresh each turn). This command is
 * the user-facing lever: it just writes the key — the patch re-reads it on the
 * next turn, so the very next ask_user_question already uses the new language.
 * No reload, no restart, no hand-editing.
 *
 * Usage:
 *   /ask-user-language            → show the current askUserLanguage
 *   /ask-user-language zh-TW      → set it (BCP-47 tag), live
 *   /ask-user-language en         → switch to English, live
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decideCommand, parseLanguageArg } from "./command.js";
import { getLanguageKey, readSettingsFile, writeLanguageKey } from "./settings.js";

const KEY = "askUserLanguage" as const;

export function registerAskUserLanguage(pi: ExtensionAPI): void {
	pi.registerCommand("ask-user-language", {
		description:
			"Show or set the ask_user_question TUI language (askUserLanguage in ~/.pi/agent/settings.json). " +
			"Overrides responseLanguage for ask_user_question content + chrome. " +
			"Usage: /ask-user-language [tag]   e.g. /ask-user-language zh-TW",
		handler: async (args, ctx) => {
			const current = getLanguageKey(readSettingsFile(), KEY);
			const outcome = decideCommand(parseLanguageArg(args), current);

			if (outcome.kind === "show") {
				ctx.ui.notify(
					outcome.current
						? `askUserLanguage = ${outcome.current}`
						: "askUserLanguage is not set (ask_user_question content falls back to responseLanguage; chrome falls back to English).",
					"info",
				);
				return;
			}

			if (outcome.kind === "invalid") {
				ctx.ui.notify(
					`Invalid language tag: "${outcome.tag}". Use a BCP-47 tag like zh-TW, en, ja.`,
					"warning",
				);
				return;
			}

			// outcome.kind === "set" — just write the key; the force-response-language
			// patch re-reads settings.json on the next turn, so no reload is needed.
			writeLanguageKey(KEY, outcome.tag);
			ctx.ui.notify(
				`ask-user language → ${outcome.tag}. The next ask_user_question will use it.`,
				"info",
			);
		},
	});
}
