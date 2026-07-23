/**
 * /memory-switch-backend <sqlite|surrealdb> — LIVE (in-process) swap of the
 * memory/search backend, without restarting pi.
 *
 * What carries over: memory entries — the .md files are the source of truth,
 * and the switch re-runs the markdown→DB sync into the new backend.
 * What does NOT carry over: session search history (sessions/messages are a
 * DB index, not in .md) — run `/memory-index-sessions` to rebuild it.
 *
 * The choice is persisted to hermes-memory-config.json so the NEXT session
 * starts on the new backend too.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DbBackend } from "../types.js";

export interface SwitchBackendDeps {
	/** Current backend tag (mutated by the switch). */
	getCurrent(): DbBackend;
	/** Perform the swap. Resolves {ok, message }; must NOT throw. */
	switchTo(target: DbBackend): Promise<{ ok: boolean; message: string }>;
	/** Human-readable label for a target, for the notify. */
	labelFor(target: DbBackend): string;
}

const VALID: readonly DbBackend[] = ["sqlite", "surrealdb"];

type UiLike = { notify?: (message: string, level?: string) => void };

function notify(ctx: ExtensionCommandContext, message: string, level?: string): void {
	const ui = (ctx as { ui?: UiLike }).ui;
	if (ui?.notify) ui.notify(message, level);
	else if (level === "error" || level === "warning") console.warn(message);
	else console.info(message);
}

export function registerSwitchBackendCommand(pi: ExtensionAPI, deps: SwitchBackendDeps): void {
	pi.registerCommand("memory-switch-backend", {
		description:
			"Live-switch the memory/search backend (sqlite | surrealdb). Memory re-syncs; session history needs /memory-index-sessions.",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const raw = Array.isArray(args) ? String(args[0] ?? "") : String(args ?? "");
			const target = raw.toLowerCase().trim() as DbBackend;
			if (!VALID.includes(target)) {
				notify(ctx, `⚠️ usage: /memory-switch-backend <sqlite|surrealdb> (got "${raw}")`, "error");
				return;
			}
			if (target === deps.getCurrent()) {
				notify(ctx, `🧠 already on ${target}: ${deps.labelFor(target)}`, "info");
				return;
			}
			notify(ctx, `🔄 switching backend → ${target} …`, "info");
			const res = await deps.switchTo(target);
			if (res.ok) {
				notify(
					ctx,
					`🧠 switched to ${target}: ${deps.labelFor(target)}\n` +
						`⚠️ session search history did not carry over — run /memory-index-sessions to rebuild.`,
					"info",
				);
			} else {
				notify(ctx, `❌ switch failed (still on ${deps.getCurrent()}): ${res.message}`, "error");
			}
		},
	});
}
