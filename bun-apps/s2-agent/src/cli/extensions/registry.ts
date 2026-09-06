/**
 * Registry of extension-backed sub-commands.
 *
 * Each entry is an `ExtensionSubcommandSpec` exported by a workspace extension.
 * `toCommand()` wraps it into the same `Command` shape the hand-written
 * `commands/*.ts` files export, so `dispatch.ts` can treat them uniformly.
 *
 * Adding a new extension sub-command = add ONE import + ONE entry here. No new
 * `commands/<x>.ts`, no edit to `COMMANDS` beyond the spread (which is already
 * in place). The extension package must be a workspace dependency.
 */
import type { Command } from "../dispatch.ts";
import { runExtensionSubcommand } from "./runner.ts";
import type { ExtensionSubcommandSpec } from "./types.ts";
import { flux2Subcommand, selfImproveSubcommand } from "@repo/s2-agent-ext-flux2/extensions/cli-subcommand.ts";
import { krea2Subcommand } from "@repo/s2-agent-ext-krea2/extensions/cli-subcommand.ts";
import { ltxSubcommand } from "@repo/s2-agent-ext-ltx/extensions/cli-subcommand.ts";
import { movieSubcommand } from "@repo/s2-agent-ext-movie-director/extensions/cli-subcommand.ts";
import { researchSubcommand } from "@repo/s2-agent-ext-web-access/extensions/cli-subcommand.ts";
import { collectVideosSubcommand, organizeVaultSubcommand, importMemorySubcommand, newsSubcommand } from "@repo/s2-agent-ext-research-tool/extensions/cli-subcommand.ts";
import { powerToolSubcommand } from "@repo/s2-agent-ext-power-tool/extensions/cli-subcommand.ts";

/** The extension sub-commands to expose on the CLI. */
export const EXTENSION_SPECS: ExtensionSubcommandSpec[] = [
	flux2Subcommand,
	selfImproveSubcommand,
	krea2Subcommand,
	ltxSubcommand,
	movieSubcommand,
	researchSubcommand,
	collectVideosSubcommand,
	organizeVaultSubcommand,
	importMemorySubcommand,
	newsSubcommand,
	powerToolSubcommand,
];

/** Wrap an extension spec as a `Command` (same shape as commands/*.ts). */
export function toCommand(spec: ExtensionSubcommandSpec): Command {
	return {
		name: spec.name,
		summary: spec.summary,
		details: spec.details,
		run: runExtensionSubcommand(spec),
	};
}

/** All extension sub-commands, ready to spread into COMMANDS. */
export const EXTENSION_COMMANDS: Command[] = EXTENSION_SPECS.map(toCommand);
