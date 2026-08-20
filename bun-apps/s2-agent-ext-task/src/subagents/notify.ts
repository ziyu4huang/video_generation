/**
 * notify.ts — SubagentNotify (Task 02 of the CC-style subagent TUI plan).
 *
 * Diff-driven transient completion-notify lines for the subagents section.
 * `diff(prev, next)` stamps AT MOST ONE pending line per tick (latest wins):
 *  - prev non-terminal → next terminal  → "✓ <actor> <status> · <elapsed>s · <latestAction>"
 *  - prev foreground:true → next foreground:false → "detached → background · <actor>"
 * The bell rings exactly once per stamped line. `take()` returns pending lines
 * and CLEARS them, so a line shows for exactly one render tick (fade rule).
 *
 * Task 06 reuses the detached→background rule for detach notifications.
 */
import { isTerminalStatus } from "@repo/s2-agent-core-runtime";
import type { RunView } from "@repo/s2-agent-core-runtime";

const ACTION_CAP = 80;

const cap = (s: string): string => (s.length > ACTION_CAP ? `${s.slice(0, ACTION_CAP)}…` : s);

export class SubagentNotify {
	private readonly bell: () => void;
	private pending: string[] = [];

	constructor(deps: { bell?: () => void } = {}) {
		this.bell = deps.bell ?? (() => process.stdout.write("\x07"));
	}

	/** Diff consecutive per-tick snapshots; stamp at most one pending line. */
	diff(prev: RunView[], next: RunView[]): void {
		const prevMap = new Map(prev.map((v) => [v.id, v]));
		let line: string | undefined;
		for (const n of next) {
			const p = prevMap.get(n.id);
			if (p && !isTerminalStatus(p.status) && isTerminalStatus(n.status)) {
				const secs = Math.round(n.elapsedMs / 1000);
				const action = n.latestAction ? ` · ${cap(n.latestAction)}` : "";
				line = `✓ ${n.actor} ${n.status} · ${secs}s${action}`;
			} else if (p?.foreground === true && n.foreground === false) {
				line = `detached → background · ${n.actor}`;
			}
		}
		if (line !== undefined) {
			this.pending = [line]; // latest wins
			this.bell();
		}
	}

	/** Return pending lines and CLEAR them (fade on next render tick). */
	take(): string[] {
		const out = this.pending;
		this.pending = [];
		return out;
	}
}
