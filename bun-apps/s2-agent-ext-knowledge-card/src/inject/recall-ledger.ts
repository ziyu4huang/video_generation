/**
 * src/inject/recall-ledger.ts — session cooldown over the t08 auto-recall
 * injector (ticket 09, context-lifecycle P2). OpenViking's RecallLedger rule,
 * transplanted: a card actually injected is COOLED for N subsequent agent
 * turns, so naive per-turn injection stops repeating the same cards every
 * turn (token waste + attention blindness). The subtle half of the rule: a
 * "no_relevant" turn records NOTHING — if a miss poisoned the ledger,
 * never-served URIs would be unfairly suppressed (the OpenViking
 * ledger-poisoning fix, verbatim).
 *
 * The ledger is INJECTOR-side session state only (per-session in-memory; the
 * durability question is deliberately deferred to t10's flip decision):
 *   - `retrieveRecords` stays pure — no session state ever enters the library,
 *     so library calls remain deterministic and testable.
 *   - `tick()` is called by the wiring once per parent agent turn, BEFORE the
 *     pipeline consults the ledger (order matters: serve sets N=3, then turns
 *     2 and 3 tick down to 2 and 1 while staying cooled, and turn 4's tick
 *     drops the entry entirely — the ticket's serve→suppress→suppress→eligible
 *     acceptance shape).
 *   - `recordServed` is called ONLY for cards whose lines actually made the
 *     injected block (post-budget): retrieved-but-dropped cards are not
 *     "served" and must stay eligible for the next turn.
 */

/** Turns a served card stays suppressed after the turn it was injected in.
 *  Default 3: served turn 1 → suppressed turns 2–3 → eligible again turn 4. */
export const DEFAULT_COOLDOWN_TURNS = 3;

export class RecallLedger {
	private cooldowns = new Map<string, number>();

	constructor(public readonly cooldownTurns: number = DEFAULT_COOLDOWN_TURNS) {}

	/** Advance one agent turn. Call BEFORE consulting the ledger in a turn —
	 *  decrement-then-read is what makes recordServed(N) suppress exactly the
	 *  next N turns and free the card on turn N+1. */
	tick(): void {
		for (const [id, remaining] of this.cooldowns) {
			if (remaining <= 1) this.cooldowns.delete(id);
			else this.cooldowns.set(id, remaining - 1);
		}
	}

	/** True while the card is still cooled (must not inject this turn). */
	isCooled(id: string): boolean {
		return this.cooldowns.has(id);
	}

	/** Record cards that were ACTUALLY injected this turn. Never call this for
	 *  a no-result / floor-miss / all-dropped turn — that is the poisoning
	 *  rule this class exists to enforce. */
	recordServed(ids: string[]): void {
		for (const id of ids) this.cooldowns.set(id, this.cooldownTurns);
	}

	/** How many cards are currently cooled (status/observability). */
	cooledCount(): number {
		return this.cooldowns.size;
	}

	/** Snapshot for the /knowledge-recall status view and tests. */
	toJSON(): Record<string, number> {
		return Object.fromEntries(this.cooldowns);
	}
}
