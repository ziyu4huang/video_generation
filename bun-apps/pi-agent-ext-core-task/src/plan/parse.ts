import type { ParsedPlan, PlanPhaseInfo, PlanPhaseStatus } from "./types.ts";

/**
 * parsePlan — pure parser: writing-plans-format markdown → ParsedPlan.
 *
 * Task ≡ phase (ticket 02). `PlanPhaseInfo.id` = the writing-plans Task number;
 * `ticketIds` = `[NN-slug]` bracketed refs in the Task header (ticket 03).
 *
 * Pure: no fs, no SDK, no globalThis. The coordinator (tracer-bullet 2) reads
 * the file and calls this; goal.ts readers (tracer-bullet 3) consume the result
 * via internal-call.
 */
const TASK_HEADER_RE = /^###\s+Task\s+(\d+)\s*[:—-]?\s*(.*)$/;
const TICKET_RE = /\[(\d{2}-[a-z0-9-]+)\]/g;
const STEP_RE = /^-\s+\[(x| )\]\s+/i;

export function parsePlan(markdown: string, sourcePath: string): ParsedPlan {
	const lines = markdown.split(/\r?\n/);
	const phases: PlanPhaseInfo[] = [];
	let cur: (PlanPhaseInfo & { _steps: number; _done: number }) | null = null;

	const flush = () => {
		if (!cur) return;
		const stepCount = cur._steps;
		const completedSteps = cur._done;
		const status: PlanPhaseStatus =
			stepCount > 0 && completedSteps === stepCount
				? "completed"
				: completedSteps > 0
					? "in_progress"
					: "pending";
		const { _steps, _done, ...rest } = cur;
		phases.push({ ...rest, stepCount, completedSteps, status });
		cur = null;
	};

	for (const line of lines) {
		const h = TASK_HEADER_RE.exec(line);
		if (h) {
			flush();
			const id = `task-${h[1]}`;
			const titleRaw = (h[2] ?? "").trim();
			const ticketIds = [...titleRaw.matchAll(TICKET_RE)].map((m) => m[1]);
			cur = {
				id,
				title: titleRaw.replace(TICKET_RE, "").trim(),
				status: "pending",
				ticketIds: ticketIds.length > 0 ? ticketIds : undefined,
				stepCount: 0,
				completedSteps: 0,
				_steps: 0,
				_done: 0,
			};
			continue;
		}
		if (!cur) continue; // skip header/preamble before the first Task
		const s = STEP_RE.exec(line);
		if (s) {
			cur._steps += 1;
			if (s[1].toLowerCase() === "x") cur._done += 1;
		}
	}
	flush();
	return { phases, sourcePath };
}
