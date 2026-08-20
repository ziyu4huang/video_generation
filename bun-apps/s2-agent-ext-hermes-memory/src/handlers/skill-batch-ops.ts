/**
 * Batch SkillStore operations for the skills manager — move / delete / confirm
 * summaries over selected skill ids.
 *
 * Extracted verbatim from skills-command.ts (architecture-deepening C2,
 * zero-behavior-change split). summarizeAction is preserved exactly as-is;
 * the latent `|| r.skillId` predicate is intentionally left untouched (deferred
 * to a separate follow-up — this cut is zero-behavior-change).
 */

import type { SkillStore } from "../store/skill-store.js";
import type { SkillIndex, SkillResult, SkillScope } from "../types.js";

function summarizeAction(
  actionVerb: string,
  targetLabel: string,
  successes: SkillResult[],
  unchanged: SkillResult[],
  blocked: Array<{ skillId: string; error: string }>,
): string[] {
  const lines: string[] = [];
  const changed = successes.filter((result) => result.message?.includes(actionVerb) || result.skillId);

  if (actionVerb === "moved") {
    lines.push(`Moved ${successes.length} skill${successes.length === 1 ? "" : "s"} to ${targetLabel}.`);
  } else if (actionVerb === "deleted") {
    lines.push(`Deleted ${successes.length} skill${successes.length === 1 ? "" : "s"}.`);
  } else {
    lines.push(`${changed.length} skill action(s) completed.`);
  }

  if (unchanged.length > 0) {
    lines.push(`${unchanged.length} already matched the target scope.`);
  }

  if (blocked.length > 0) {
    lines.push(`Blocked ${blocked.length} skill${blocked.length === 1 ? "" : "s"}:`);
    for (const item of blocked.slice(0, 4)) {
      lines.push(`- ${item.skillId}: ${item.error}`);
    }
    if (blocked.length > 4) {
      lines.push(`- …and ${blocked.length - 4} more`);
    }
  }

  return lines;
}

type SkillMoveStore = Pick<SkillStore, "move" | "loadIndex" | "getProjectName">;
type SkillDeleteStore = Pick<SkillStore, "delete" | "loadIndex">;
export type ConfirmDialog = (title: string, message: string) => Promise<boolean>;

export interface SkillBatchActionResult {
  skills: SkillIndex[];
  summaryLines: string[];
  retainSelectedSkillIds?: string[];
  focusSkillId?: string;
}

export async function moveSelectedSkills(
  store: SkillMoveStore,
  skillIds: string[],
  targetScope: SkillScope,
): Promise<SkillBatchActionResult> {
  const dedupedSkillIds = Array.from(new Set(skillIds));
  const currentSkills = await store.loadIndex();

  if (dedupedSkillIds.length === 0) {
    return {
      skills: currentSkills,
      summaryLines: ["Select one or more skills first."],
    };
  }

  if (targetScope === "project" && !store.getProjectName()) {
    return {
      skills: currentSkills,
      summaryLines: ["Move to project is unavailable: no active project detected."],
      retainSelectedSkillIds: dedupedSkillIds,
    };
  }

  const successes: SkillResult[] = [];
  const unchanged: SkillResult[] = [];
  const blocked: Array<{ skillId: string; error: string }> = [];

  for (const skillId of dedupedSkillIds) {
    try {
      const result = await store.move(skillId, targetScope);
      if (result.success) {
        if (result.skillId === skillId && result.scope === targetScope) {
          unchanged.push(result);
        } else {
          successes.push(result);
        }
      } else {
        blocked.push({ skillId, error: result.error || "Unknown move failure." });
      }
    } catch (error) {
      blocked.push({
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const refreshedSkills = await store.loadIndex();
  const focusSkillId = blocked[0]?.skillId
    ?? successes[0]?.skillId
    ?? unchanged[0]?.skillId;

  return {
    skills: refreshedSkills,
    summaryLines: summarizeAction("moved", targetScope, successes, unchanged, blocked),
    retainSelectedSkillIds: blocked.map((item) => item.skillId),
    focusSkillId,
  };
}

export async function deleteSelectedSkills(
  store: SkillDeleteStore,
  skillIds: string[],
): Promise<SkillBatchActionResult> {
  const dedupedSkillIds = Array.from(new Set(skillIds));
  const currentSkills = await store.loadIndex();

  if (dedupedSkillIds.length === 0) {
    return {
      skills: currentSkills,
      summaryLines: ["Select one or more skills first."],
    };
  }

  const successes: SkillResult[] = [];
  const blocked: Array<{ skillId: string; error: string }> = [];

  for (const skillId of dedupedSkillIds) {
    try {
      const result = await store.delete(skillId);
      if (result.success) {
        successes.push(result);
      } else {
        blocked.push({ skillId, error: result.error || "Unknown delete failure." });
      }
    } catch (error) {
      blocked.push({
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const refreshedSkills = await store.loadIndex();

  return {
    skills: refreshedSkills,
    summaryLines: summarizeAction("deleted", "delete", successes, [], blocked),
    retainSelectedSkillIds: blocked.map((item) => item.skillId),
    focusSkillId: blocked[0]?.skillId,
  };
}

export async function confirmDeleteSelectedSkills(
  confirm: ConfirmDialog,
  store: SkillDeleteStore,
  skillIds: string[],
): Promise<SkillBatchActionResult> {
  const currentSkills = await store.loadIndex();
  if (skillIds.length === 0) {
    return { skills: currentSkills, summaryLines: ["Select one or more skills first."] };
  }

  const confirmed = await confirm(
    "Delete selected skills?",
    `Delete ${skillIds.length} selected skill${skillIds.length === 1 ? "" : "s"}? This cannot be undone.`,
  );

  if (!confirmed) {
    return {
      skills: currentSkills,
      summaryLines: ["Delete cancelled."],
      retainSelectedSkillIds: skillIds,
      focusSkillId: skillIds[0],
    };
  }

  return deleteSelectedSkills(store, skillIds);
}
