/**
 * Session-scoped shared task board for a parent session and its agents
 * (agent-teams parity, effort `.planning/2026-08-22-subagent-teams-parity`
 * ticket 03).
 *
 * The store is IN-MEMORY and process-local by design: a team task list is
 * board state for ONE parent session's working set — `session_start` resets
 * it, `session_shutdown` drops it. Permanent tracking already lives in
 * wayfind (see ext-task's CONTEXT); the in-process singleton sharing that
 * would be a contamination bug for session todos is exactly the feature here
 * (the parent, spawn children, and workflow agents all resolve the SAME
 * store instance through this package's barrel).
 *
 * Keyed by parent sessionId like {@link LiveAgentEntry.sessionId}: consumers
 * that have no session token (the tool adapters) use the `"*"` scope — in
 * this process there is exactly one parent session at a time, the same
 * rationale as `LiveAgentRegistry.disposeFor("*")`.
 */

/** Lifecycle of a team task. */
export type TeamTaskStatus = "pending" | "in_progress" | "completed";

/**
 * One task on the shared board. `blocks` / `blockedBy` are kept as symmetric
 * inverse edge lists (linking A→B through either side updates both tasks) so
 * readers never see a half-linked pair.
 */
export interface TeamTask {
  /** Per-board monotonic id ("1", "2", …) — the handle every tool takes. */
  id: string;
  subject: string;
  description: string;
  /** Present-continuous label for the task (shown while in_progress). */
  activeForm?: string;
  status: TeamTaskStatus;
  /** Who claimed it: a live agent's `name`, or "main" for the parent. Unowned until claimed. */
  owner?: string;
  /** ids of tasks THIS task blocks (symmetric with their blockedBy). */
  blocks: string[];
  /** ids of tasks that must complete before this one (symmetric with their blocks). */
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  readonly createdAt: number;
  updatedAt: number;
}

/** Input for {@link TeamTaskStore.create}. */
export interface TeamTaskCreateInput {
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  /** ids this task is blocked by; validated (must exist, must not cycle). */
  blockedBy?: string[];
  /** ids this task blocks; validated (must exist, must not cycle). */
  blocks?: string[];
}

/** Patch for {@link TeamTaskStore.update}. Omitted fields stay untouched. */
export interface TeamTaskUpdatePatch {
  subject?: string;
  description?: string;
  /** Clear an optional field by passing null. */
  activeForm?: string | null;
  status?: TeamTaskStatus;
  /** Claim / re-assign the task (an empty-string owner is rejected). */
  owner?: string | null;
  metadata?: Record<string, unknown>;
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
  addBlocks?: string[];
  removeBlocks?: string[];
}

/** Error result shape shared by the mutating methods (mirrors LiveAgentRegistry.register). */
export type TeamTaskError = { error: string };

export function isTeamTaskError(v: unknown): v is TeamTaskError {
  return typeof v === "object" && v !== null && "error" in v;
}

interface TaskBoard {
  tasks: Map<string, TeamTask>;
  nextId: number;
}

function newBoard(): TaskBoard {
  return { tasks: new Map(), nextId: 1 };
}

/**
 * Whether adding "dependent blockedBy blocker" would close a dependency
 * cycle: it would iff `blocker` already reaches `dependent` through blockedBy
 * edges. Depth-first over the candidate graph; edge lists are short and
 * boards are session-sized, so no memoization is needed.
 */
function closesCycle(board: TaskBoard, dependentId: string, blockerId: string): boolean {
  const seen = new Set<string>();
  const stack = [blockerId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === dependentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = board.tasks.get(id);
    if (t) stack.push(...t.blockedBy);
  }
  return false;
}

/** One undirected-in-storage dependency edge: dependent.blockedBy += blocker AND blocker.blocks += dependent. */
function linkEdge(board: TaskBoard, dependentId: string, blockerId: string): TeamTaskError | undefined {
  const dependent = board.tasks.get(dependentId);
  const blocker = board.tasks.get(blockerId);
  if (!dependent || !blocker) {
    return { error: `unknown task id "${!dependent ? dependentId : blockerId}" (board has ${board.tasks.size} tasks)` };
  }
  if (dependentId === blockerId) {
    return { error: `task #${dependentId} cannot depend on itself` };
  }
  if (dependent.blockedBy.includes(blockerId)) return undefined; // already linked — idempotent
  if (closesCycle(board, dependentId, blockerId)) {
    return { error: `edge #${dependentId} blockedBy #${blockerId} would close a dependency cycle (rejected)` };
  }
  dependent.blockedBy.push(blockerId);
  blocker.blocks.push(dependentId);
  return undefined;
}

/** Remove one dependency edge from both sides (idempotent). */
function unlinkEdge(board: TaskBoard, dependentId: string, blockerId: string): void {
  const dependent = board.tasks.get(dependentId);
  const blocker = board.tasks.get(blockerId);
  if (dependent) dependent.blockedBy = dependent.blockedBy.filter((id) => id !== blockerId);
  if (blocker) blocker.blocks = blocker.blocks.filter((id) => id !== dependentId);
}

/**
 * Process-local store of per-session task boards. All methods are
 * synchronous — validation, edge linking, and roster reads; persistence
 * belongs to no one (this board deliberately dies with the session).
 */
export class TeamTaskStore {
  private boards = new Map<string, TaskBoard>();

  private boardFor(sessionId: string): TaskBoard {
    let board = this.boards.get(sessionId);
    if (!board) {
      board = newBoard();
      this.boards.set(sessionId, board);
    }
    return board;
  }

  create(sessionId: string, input: TeamTaskCreateInput): TeamTask | TeamTaskError {
    const subject = input.subject?.trim();
    if (!subject) return { error: "subject is required (non-empty)" };
    if (input.owner !== undefined && input.owner !== null && input.owner.trim() === "") {
      return { error: 'owner must be a live agent name or "main", not an empty string' };
    }
    const board = this.boardFor(sessionId);
    // Reserve the id first so edge validation during create can resolve it.
    const id = String(board.nextId++);
    const now = Date.now();
    const task: TeamTask = {
      id,
      subject,
      description: input.description ?? "",
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      status: "pending",
      ...(input.owner ? { owner: input.owner } : {}),
      blocks: [],
      blockedBy: [],
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: now,
      updatedAt: now,
    };
    board.tasks.set(id, task);
    // Edge inputs validated AFTER the task exists (they may reference it), but
    // failures unwind the create ENTIRELY — the unborn task AND every edge
    // already linked in earlier iterations. Unwinding only the task would
    // leave a dangling id on a survivor's blocks/blockedBy list, and the id is
    // then reused, silently attaching that stale edge to an unrelated future
    // task (review Major 1).
    const appliedEdges: Array<[dependentId: string, blockerId: string]> = [];
    const failCreate = (err: TeamTaskError): TeamTaskError => {
      for (const [dependentId, blockerId] of appliedEdges) unlinkEdge(board, dependentId, blockerId);
      board.tasks.delete(id);
      board.nextId--; // the id was never born; reuse it (create is sync, no observer saw it)
      return err;
    };
    for (const blockerId of input.blockedBy ?? []) {
      const err = linkEdge(board, id, blockerId);
      if (err) return failCreate(err);
      appliedEdges.push([id, blockerId]);
    }
    for (const dependentId of input.blocks ?? []) {
      const err = linkEdge(board, dependentId, id);
      if (err) return failCreate(err);
      appliedEdges.push([dependentId, id]);
    }
    return task;
  }

  get(sessionId: string, id: string): TeamTask | undefined {
    return this.boards.get(sessionId)?.tasks.get(id);
  }

  /** All tasks on the board, in creation order. */
  list(sessionId: string): TeamTask[] {
    const board = this.boards.get(sessionId);
    return board ? [...board.tasks.values()] : [];
  }

  update(sessionId: string, id: string, patch: TeamTaskUpdatePatch): TeamTask | TeamTaskError {
    const board = this.boards.get(sessionId);
    const task = board?.tasks.get(id);
    if (!board || !task) return { error: `unknown task id "${id}" on this session's board` };
    if (patch.subject !== undefined) {
      const subject = patch.subject.trim();
      if (!subject) return { error: "subject cannot be emptied" };
    }
    if (patch.owner !== undefined && patch.owner !== null && patch.owner.trim() === "") {
      return { error: 'owner must be a live agent name or "main", not an empty string' };
    }
    // Edge edits are ATOMIC: removals first (they cannot cycle), then additions
    // validated against the working graph — and ANY failure restores the whole
    // board's edge state from the snapshot below (review Minor 2). Without the
    // restore, a failed addition strand applied removals/earlier additions and
    // an LLM reading "rejected" believes nothing changed.
    const edgeSnapshot = new Map<string, { blocks: string[]; blockedBy: string[] }>();
    for (const [tid, t] of board.tasks) edgeSnapshot.set(tid, { blocks: [...t.blocks], blockedBy: [...t.blockedBy] });
    const restoreEdges = () => {
      for (const [tid, t] of board.tasks) {
        const snap = edgeSnapshot.get(tid);
        if (snap) {
          t.blocks = snap.blocks;
          t.blockedBy = snap.blockedBy;
        }
      }
    };
    for (const blockerId of patch.removeBlockedBy ?? []) unlinkEdge(board, id, blockerId);
    for (const dependentId of patch.removeBlocks ?? []) unlinkEdge(board, dependentId, id);
    for (const blockerId of patch.addBlockedBy ?? []) {
      const err = linkEdge(board, id, blockerId);
      if (err) {
        restoreEdges();
        return err;
      }
    }
    for (const dependentId of patch.addBlocks ?? []) {
      const err = linkEdge(board, dependentId, id);
      if (err) {
        restoreEdges();
        return err;
      }
    }
    if (patch.subject !== undefined) task.subject = patch.subject.trim();
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.activeForm !== undefined) {
      if (patch.activeForm === null) delete task.activeForm;
      else task.activeForm = patch.activeForm;
    }
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.owner !== undefined) {
      if (patch.owner === null) delete task.owner;
      else task.owner = patch.owner;
    }
    if (patch.metadata !== undefined) task.metadata = patch.metadata;
    task.updatedAt = Date.now();
    return task;
  }

  /** session_start: the new session starts with an empty board. */
  reset(sessionId: string): void {
    this.boards.set(sessionId, newBoard());
  }

  /**
   * session_shutdown: drop the board(s) for the ending session(s). `"*"` (the
   * tool adapters' scope) drops every board — the one-parent-session-per-
   * process reality, same as LiveAgentRegistry.disposeFor.
   */
  drop(sessionId: string): number {
    let n = 0;
    for (const key of [...this.boards.keys()]) {
      if (key === sessionId || sessionId === "*") {
        this.boards.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Total tasks across boards (diagnostics / test assertions). */
  get size(): number {
    let n = 0;
    for (const board of this.boards.values()) n += board.tasks.size;
    return n;
  }
}

let _teamTaskStoreSingleton: TeamTaskStore | undefined;

/**
 * Process-wide singleton — the subagent extension's task tools, children
 * reached through the extensionTools bridge, and workflow agents all resolve
 * ONE store through this package's barrel (the shared-module-identity rule).
 */
export function getTeamTaskStore(): TeamTaskStore {
  // biome-ignore lint/suspicious/noAssignInExpressions: lazy-init singleton idiom
  return (_teamTaskStoreSingleton ??= new TeamTaskStore());
}

/** Test-only: reset the singleton (same shared-module-identity trap as the registries). */
export function __resetTeamTaskStoreForTests(): void {
  _teamTaskStoreSingleton = undefined;
}
