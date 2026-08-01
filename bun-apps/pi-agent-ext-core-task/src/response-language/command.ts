/**
 * command.ts — pure decision logic for the /response-language command.
 *
 * The registrar (response-language.ts) is a thin wrapper that
 * turns a CommandOutcome into side effects (notify / write / reload). Keeping
 * the decision pure makes the command unit-testable without a real
 * ExtensionCommandContext.
 */
import { isValidTag } from "./settings.js";

export interface ParsedLanguageArg {
	/** The original raw arg string. */
	raw: string;
	/** The trimmed tag, or undefined when no arg was given. */
	tag: string | undefined;
}

/**
 * Pure: parse the raw command arg string into a trimmed tag, or undefined when
 * the user invoked the command with no argument.
 */
export function parseLanguageArg(raw: string): ParsedLanguageArg {
	const tag = raw.trim();
	return { raw, tag: tag || undefined };
}

export type CommandOutcome =
	| { kind: "show"; current: string | undefined }
	| { kind: "invalid"; tag: string }
	| { kind: "set"; tag: string };

/**
 * Pure: given the parsed arg and the current responseLanguage, decide what the
 * handler should do.
 *   - no arg            → "show" the current value
 *   - arg fails isValidTag → "invalid"
 *   - otherwise         → "set" (persist + rebuild)
 */
export function decideCommand(
	parsed: ParsedLanguageArg,
	current: string | undefined,
): CommandOutcome {
	if (parsed.tag === undefined) return { kind: "show", current };
	if (!isValidTag(parsed.tag)) return { kind: "invalid", tag: parsed.tag };
	return { kind: "set", tag: parsed.tag };
}
