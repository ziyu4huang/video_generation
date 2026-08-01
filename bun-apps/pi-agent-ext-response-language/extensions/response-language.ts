/**
 * response-language extension — registers the `/response-language` slash command
 * for live, immediate control of the agent's reply language.
 *
 * The forced injection itself is applied by the `force-response-language`
 * patch in `bun-apps/pi-agent/src/patches/` (it prepends a forced block to every
 * turn's system prompt, reading `responseLanguage` fresh each turn). This
 * command is the user-facing lever: it just writes the key to
 * `~/.pi/agent/settings.json` — the patch re-reads it on the next turn, so the
 * very next reply already uses the new language. No reload, no restart, no
 * hand-editing.
 *
 * Usage:
 *   /response-language            → show the current responseLanguage
 *   /response-language zh-TW      → set it (BCP-47 tag), live
 *   /response-language en         → switch to English, live
 *
 * Install: registered in bun-apps/pi-agent/run-dir/manifest.json (extensions[]).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decideCommand, parseLanguageArg } from "../src/command.js";
import { getResponseLanguage, readSettingsFile, writeResponseLanguage } from "../src/settings.js";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("response-language", {
		description:
			"Show or set the agent's reply language (responseLanguage in ~/.pi/agent/settings.json). " +
			"Usage: /response-language [tag]   e.g. /response-language zh-TW",
		handler: async (args, ctx) => {
			const current = getResponseLanguage(readSettingsFile());
			const outcome = decideCommand(parseLanguageArg(args), current);

			if (outcome.kind === "show") {
				ctx.ui.notify(
					outcome.current
						? `responseLanguage = ${outcome.current}`
						: "responseLanguage is not set (the agent uses its default language).",
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
			writeResponseLanguage(outcome.tag);
			ctx.ui.notify(
				`Response language → ${outcome.tag}. The next reply will use it.`,
				"info",
			);
		},
	});
}
