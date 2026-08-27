/**
 * colliding-command-dispatch — patches ExtensionRunner.prototype.getCommand so
 * a command name registered by MULTIPLE extensions still resolves by its plain
 * name.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * When two extensions `registerCommand("loop", …)` (the repo had exactly this
 * until 2026-08-28: s2-agent-ext-task's scheduler retired into
 * s2-agent-ext-ultracode's WakeupRegistry, cc-parity-task ticket 03, leaving
 * ONE /loop), upstream 0.84.2's `resolveRegisteredCommands()` renames
 * BOTH registrations to `loop:1` / `loop:2` for disambiguation — and
 * `getCommand("loop")` then returns undefined. Every dispatch path that looks
 * the command up by plain name silently degrades: `AgentSession.prompt()`'s
 * slash handling (`_tryExecuteExtensionCommand`) finds no command, does NOT
 * consume the message, and the literal `/loop …` text is sent to the MODEL as
 * an ordinary prompt. Measured 2026-08-23 (headless-dispatch-hang ticket 03 /
 * B4): a `-p '/loop dynamic …'` dispatch fell through and the model ran off
 * exploring until the print-idle-watchdog bounded the run.
 *
 * PATCH LOGIC
 * -----------
 *   getCommand(name)          →  miss AND name has no ":"  →  retry getCommand(`${name}:1`)
 *
 * The fallback is deterministic (first registration in extension-load order)
 * and fixes the CLASS, not the pair: any future collision keeps its primary
 * reachable by plain name while `name:2` etc. stay explicitly addressable.
 * The command PALETTE is unaffected — it lists `resolveRegisteredCommands()`
 * entries directly (their suffixed invocation names), not `getCommand()`.
 *
 * Env gate: BUN_PI_COLLIDING_COMMAND_DISPATCH (default on). Reversible.
 */

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

function applyCollidingCommandDispatchPatch(): boolean {
	const proto = ExtensionRunner.prototype as unknown as Record<string, unknown>;
	const original = proto.getCommand as ((name: string) => unknown) | undefined;
	if (!original || typeof original !== "function") return false;

	proto.getCommand = function (this: unknown, name: string): unknown {
		const found = original.call(this, name);
		if (found !== undefined && found !== null) return found;
		// Only plain names fall back — an explicit "name:2" miss must stay a
		// miss (it names a registration that does not exist).
		if (typeof name !== "string" || name.includes(":")) return found;
		return original.call(this, `${name}:1`);
	};

	return true;
}

export const patchApplied = applyCollidingCommandDispatchPatch();
