export type PlanPhaseStatus = "pending" | "in_progress" | "completed";

export interface PlanPhaseInfo {
	id: string; // "task-<N>"
	title: string;
	status: PlanPhaseStatus;
	ticketIds?: string[]; // [NN-slug] refs from the Task header
	stepCount: number;
	completedSteps: number;
}

export interface ParsedPlan {
	phases: PlanPhaseInfo[];
	sourcePath: string;
}
