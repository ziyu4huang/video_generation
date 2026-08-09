/**
 * Plan coordinator — parses + caches the active effort's plan per-cwd and serves
 * the 3 read functions published as `__piPlan*` (ticket 09, tracer-bullet 2).
 *
 * Pure logic (`computeIncomplete`/`computeSummary`) is unit-tested directly;
 * `discoverActivePlan`/`refreshPlan` (fs) tested via temp dir. goal.ts self-
 * consumes these via internal-call (tracer-bullet 3) — NOT via globalThis.
 *
 * Discovery: the active effort = the `.planning/<effort>/` with the newest
 * `map.md`; aggregate phases from its `plans/*.md`. No cross-effort fallback: if
 * the active effort has no `plans/`, there is "no active plan" (#278). Legacy
 * global fallback (docs/superpowers/plans/) only when no effort exists at all.
 * Multi-plan precision / effort-selection refinement = ticket 05 (deferred).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parsePlan } from "./parse.ts";
import type { PlanPhaseInfo, ParsedPlan } from "./types.ts";

// ─── Pure logic (unit-tested directly) ────────────────────────────────────────

export function computeIncomplete(phases: PlanPhaseInfo[]): boolean {
	return phases.length > 0 && phases.some((p) => p.status !== "completed");
}

export function computeSummary(phases: PlanPhaseInfo[], sourcePath: string): string {
	if (phases.length === 0) return "";
	const done = phases.filter((p) => p.status === "completed").length;
	return `${done}/${phases.length} phases · ${sourcePath}`;
}

// ─── fs discovery + per-cwd cache ─────────────────────────────────────────────

const cache = new Map<string, ParsedPlan | undefined>();

function newestByMtime(paths: string[]): string | undefined {
	let best: { p: string; t: number } | undefined;
	for (const p of paths) {
		if (!existsSync(p)) continue;
		const t = statSync(p).mtimeMs;
		if (!best || t > best.t) best = { p, t };
	}
	return best?.p;
}

function listMd(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => join(dir, f));
}

/** Active effort = the `.planning/<effort>/` whose map.md is newest; else undefined. */
function activeEffort(planningDir: string): string | undefined {
	if (!existsSync(planningDir)) return undefined;
	const efforts = readdirSync(planningDir).filter((f) => {
		try {
			return statSync(join(planningDir, f)).isDirectory();
		} catch {
			return false;
		}
	});
	const activeMap = newestByMtime(efforts.map((e) => join(planningDir, e, "map.md")));
	return activeMap ? basename(dirname(activeMap)) : undefined;
}

export function discoverActivePlan(cwd: string): ParsedPlan | undefined {
	const planningDir = join(cwd, ".planning");
	const effort = activeEffort(planningDir);
	if (effort) {
		const plansDir = join(planningDir, effort, "plans");
		const files = listMd(plansDir);
		if (files.length > 0) {
			const phases: PlanPhaseInfo[] = [];
			for (const f of files) phases.push(...parsePlan(readFileSync(f, "utf8"), f).phases);
			return { phases, sourcePath: plansDir };
		}
		// Active effort exists but has no plans/ — surface "no active plan" for THIS
		// effort instead of cross-contaminating from the global docs/superpowers/
		// plans/ (≈ .planning/plans/) or another effort's plans (failure memory
		// #278: an unrelated stale plan → goal_complete false-positive).
		return undefined;
	}
	// Legacy fallback (no effort at all): newest plan in docs/superpowers/plans/.
	const dsFiles = listMd(join(cwd, "docs", "superpowers", "plans"));
	if (dsFiles.length > 0) {
		const newest = dsFiles
			.map((f) => ({ f, t: statSync(f).mtimeMs }))
			.sort((a, b) => b.t - a.t)[0]!.f;
		return parsePlan(readFileSync(newest, "utf8"), newest);
	}
	return undefined;
}

/** Tools that can modify a plan file → trigger a plan re-parse (TB5a: refresh gating). */
const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/** Whether the plan cache should refresh after a tool ran (TB5a: mutating tools only). */
export function shouldRefreshAfterTool(toolName: string): boolean {
	return MUTATING_TOOLS.has(toolName);
}

export function refreshPlan(cwd: string): void {
	cache.set(cwd, discoverActivePlan(cwd));
}

export function getPlanPhases(cwd: string): PlanPhaseInfo[] {
	return cache.get(cwd)?.phases ?? [];
}

export function isPlanIncomplete(cwd: string): boolean {
	return computeIncomplete(getPlanPhases(cwd));
}

export function getPlanSummary(cwd: string): string {
	const plan = cache.get(cwd);
	return plan ? computeSummary(plan.phases, plan.sourcePath) : "";
}

export function __resetCoordinator(): void {
	cache.clear();
}
