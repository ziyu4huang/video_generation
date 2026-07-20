/**
 * Plan → todo seeding (ticket 09, tracer-bullet 4). The plan is the source of
 * truth for STRUCTURE (plan-master, ticket 02); this seeds the todo with the
 * plan's phases (Tasks) so the agent sees the roadmap as its checklist — but
 * ONLY when the todo is empty, so replay-from-branch / in-session work is never
 * clobbered. One-way (plan → todo); the plan file stays the source of truth
 * (the coordinator re-parses it on tool_execution_end).
 */
import { getPlanPhases } from "./coordinator.js";
import type { PlanPhaseInfo } from "./types.js";
import { getNextId, getTodos, replaceState } from "../todo/state/store.js";
import type { TaskState } from "../todo/state/state.js";
import type { Task } from "../todo/tool/types.js";

/** Build a TaskState from plan phases (pure). Each phase → one Task. */
export function buildTodoFromPhases(phases: PlanPhaseInfo[], nextId: number): TaskState {
	let id = nextId;
	const tasks: Task[] = phases.map((p) => {
		const tickets = p.ticketIds?.length ? ` · ${p.ticketIds.join(", ")}` : "";
		return {
			id: id++,
			subject: p.title,
			description: `${p.completedSteps}/${p.stepCount} steps${tickets}`,
			activeForm: `working on ${p.title}`,
			// PlanPhaseInfo.status ⊆ TaskStatus (pending|in_progress|completed).
			status: p.status,
			metadata: { planPhaseId: p.id },
		};
	});
	return { tasks, nextId: id };
}

/**
 * Seed the todo from the active plan's phases — only when the todo is empty, so
 * replay-from-branch / prior in-session work is never overwritten. Returns true
 * if it seeded. No-op when no plan is cached or the todo already has tasks.
 */
export function seedTodoFromPlan(cwd: string): boolean {
	const phases = getPlanPhases(cwd);
	if (phases.length === 0) return false; // no plan → nothing to seed
	if (getTodos().length > 0) return false; // don't clobber existing work
	replaceState(buildTodoFromPhases(phases, getNextId()));
	return true;
}
