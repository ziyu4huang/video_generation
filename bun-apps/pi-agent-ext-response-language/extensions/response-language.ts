/**
 * response-language extension — registers the `/response-language` slash command
 * for live, immediate control of the agent's reply language.
 *
 * The forced injection itself is applied by the `force-response-language`
 * patch in `bun-apps/pi-agent/src/patches/` (it prepends a forced block to every
 * session's system prompt, reading `responseLanguage` fresh on each rebuild).
 * This command is the user-facing lever: it writes the key to
 * `~/.pi/agent/settings.json` and triggers `ctx.reload()` so the very next
 * reply already uses the new language — no restart, no hand-editing.
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

			// outcome.kind === "set"
			writeResponseLanguage(outcome.tag);
			ctx.ui.notify(
				`Response language → ${outcome.tag}. Rebuilding the prompt — the next reply will use it.`,
				"info",
			);
			await ctx.reload();
		},
	});
}
