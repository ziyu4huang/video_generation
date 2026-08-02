/**
 * presence.ts — which composite-status elements are actionable right now, and
 * the slash-command each one runs when selected from the launcher panel.
 *
 * Pure + dependency-injected (defaults read the real sources) so the decision
 * tree is fully unit-testable without touching goal/todo state or globalThis.
 * Commands carry a leading "/" (parity with pi-agent-ext-picker's toCommandItems)
 * because the panel auto-submits via the framework-wired onSubmit slash-dispatch.
 */
import { isGoalActive } from "../goal/goal.js";
import { getTodos } from "../todo/state/store.js";

export type StatusElementId = "goal" | "todo" | "wayfind";

export interface PanelEntry {
  id: StatusElementId;
  label: string;
  command: string;
}

export interface PresenceDeps {
  isGoalActive: () => boolean;
  getTodoCount: () => number;
  isWayfindActive: () => boolean;
}

/** Read the callable globalThis wayfind seam; absent/non-callable → false. */
function defaultWayfindActive(): boolean {
  const fn = (globalThis as Record<string, unknown>).__piWayfindActive;
  return typeof fn === "function" ? (fn as () => boolean)() : false;
}

const defaultDeps: PresenceDeps = {
  isGoalActive,
  getTodoCount: () => getTodos().length,
  isWayfindActive: defaultWayfindActive,
};

/**
 * Actionable elements in composite-widget section order (goal=0, todo=1,
 * wayfind=2). Absent elements are omitted (hide-empty). Empty list ⇒ the
 * trigger passes Down through (no panel).
 */
export function getPanelEntries(deps: PresenceDeps = defaultDeps): PanelEntry[] {
  const entries: PanelEntry[] = [];
  if (deps.isGoalActive()) entries.push({ id: "goal", label: "goal — show active goal", command: "/goal" });
  if (deps.getTodoCount() > 0) entries.push({ id: "todo", label: "todo — open list", command: "/todos" });
  if (deps.isWayfindActive()) entries.push({ id: "wayfind", label: "wayfind — status", command: "/wayfind status" });
  return entries;
}
