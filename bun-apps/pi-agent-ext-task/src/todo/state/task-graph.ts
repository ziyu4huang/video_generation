import type { Task } from "../tool/types";

/**
 * Detect whether the given `blockedBy` set for `taskId` would introduce a cycle
 * in the dependency graph. The caller must pass the already-merged set (i.e.,
 * the result of applying addBlockedBy and removeBlockedBy).
 */
export function detectCycle(taskList: readonly Task[], taskId: number, blockedBy: readonly number[]): boolean {
	const edges = new Map<number, number[]>();
	for (const t of taskList) {
		if (t.id === taskId) {
			edges.set(t.id, [...blockedBy]);
		} else {
			edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
		}
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();
	const hasCycleFrom = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const nb of edges.get(node) ?? []) {
			if (hasCycleFrom(nb)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	for (const node of edges.keys()) {
		if (hasCycleFrom(node)) return true;
	}
	return false;
}

/**
 * Build the inverse adjacency map: for each task `T`, which other tasks list
 * `T` in their `blockedBy`.
 */
export function deriveBlocks(taskList: readonly Task[]): Map<number, number[]> {
	const blocks = new Map<number, number[]>();
	for (const t of taskList) {
		for (const dep of t.blockedBy ?? []) {
			const arr = blocks.get(dep) ?? [];
			arr.push(t.id);
			blocks.set(dep, arr);
		}
	}
	return blocks;
}
