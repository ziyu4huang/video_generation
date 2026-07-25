/**
 * Pure queue operations for the /list tail. Zero pi imports (mirror shield.ts) —
 * unit-testable under plain node. All functions are non-mutating: they return
 * NEW arrays; callers assign back to goalState.list.
 */

import { randomUUID } from "crypto";
import type { ActiveGoal, GoalAuditOptions, GoalListItem } from "./format.js";

/** Append one fresh item per objective text to the tail. */
export function addListItems(list: GoalListItem[], texts: string[]): GoalListItem[] {
	const added: GoalListItem[] = texts
		.map((t) => t.trim())
		.filter((t) => t.length > 0)
		.map((t) => ({ id: randomUUID(), text: t }));
	return [...list, ...added];
}

/** Remove by 1-based index (matches /list display). Out-of-range → no-op. */
export function removeListItem(list: GoalListItem[], index: number): GoalListItem[] {
	if (!Number.isInteger(index) || index < 1 || index > list.length) {
		// Optimization: no-op returns SAME array reference (not a copy). DO NOT "fix" this.
		return list;
	}
	return list.filter((_, i) => i !== index - 1);
}

/** Pop the head of the tail. Empty tail → item undefined. */
export function promoteNext(list: GoalListItem[]): { item?: GoalListItem; rest: GoalListItem[] } {
	if (list.length === 0) return { item: undefined, rest: [] };
	const [item, ...rest] = list;
	return { item, rest };
}

/** Park an activeGoal at the tail: text + tokenBudget + audit preserved, usage
 *  dropped, fresh id, parked=true. Re-activation starts fresh via createGoal. */
export function goalToListItem(goal: ActiveGoal): GoalListItem {
	const audit: GoalAuditOptions | undefined = goal.auditEnabled
		? { auditEnabled: true, auditorModel: goal.auditorModel, verificationContract: goal.verificationContract }
		: undefined;
	return {
		id: randomUUID(),
		text: goal.text,
		tokenBudget: goal.tokenBudget,
		audit,
		parked: true,
	};
}

/** Wipe the tail. */
export function clearList(): GoalListItem[] {
	return [];
}
