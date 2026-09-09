/**
 * repoint-next-goal — the WRITE-path twin of validate-next-goal (self-arc-19
 * D4: the validator stays a pure exit-code contract; grafting writes onto it
 * muddies both). One command makes the stale-byte-duplicate class structurally
 * impossible to leave behind:
 *
 *   bun bun-apps/s2-agent-ext-devops/scripts/repoint-next-goal.ts <target> [--check]
 *
 *   1. validate the target (validateNextGoalFile, reused as-is),
 *   2. dedupe the queue: byte-identical next-goal groups keep the NEWEST
 *      filename, the rest are deleted and reported — if the requested target
 *      is itself a stale duplicate, the repoint re-targets to the newest twin
 *      (the exact 2026-09-10 live incident),
 *   3. supersedes honesty: the target's `supersedes:` filename timestamp must
 *      be strictly OLDER than the target's own,
 *   4. repoint `output/LATEST-next-goal.md` atomically (tmp + rename) as a
 *      RELATIVE symlink — the only form doctorNextGoal can health-check; a
 *      previously-regular-file LATEST is switched and the switch is REPORTED
 *      (verify the artifact, never silently change it),
 *   5. doctor the queue and print one JSON result.
 *
 * Failure ordering matters: if validation or supersedes-order fails, NOTHING
 * is deleted and the pointer is not touched — a failed repoint never destroys
 * queue history. `--check` reports the plan and mutates nothing.
 *
 * Pure-ish logic, temp-dir testable: tests import planRepoint/execRepoint
 * directly; scripts/repoint-next-goal.ts is the thin runnable entry.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  type NextGoalDoctor,
  type NextGoalValidation,
  NEXT_GOAL_FILENAME_RE,
  doctorNextGoal,
  validateNextGoalFile,
} from "./validate-next-goal.js";

export interface DupDeletion {
  file: string;
  newerTwin: string;
}

export interface RepointPlan {
  outputDir: string;
  requestedTarget: string;
  resolvedTarget: string;
  /** Present when the requested target was a stale byte-duplicate of a newer file. */
  retargeted: { from: string; to: string; reason: string } | false;
  validation: NextGoalValidation | undefined;
  supersedesOrder: { ok: boolean; detail?: string };
  /** Byte-identical older twins planned for deletion (newest of each group is kept). */
  deletions: DupDeletion[];
}

export interface RepointResult extends RepointPlan {
  ok: boolean;
  checkOnly: boolean;
  deleted: DupDeletion[];
  repointed: boolean;
  latestForm: "symlink" | "untouched";
  doctor: NextGoalDoctor | undefined;
  problems: string[];
}

function filenameTs(name: string): string | undefined {
  const m = NEXT_GOAL_FILENAME_RE.exec(name);
  return m ? `${m[1]}${m[2]}` : undefined;
}

/** The `supersedes:` value from a file's frontmatter (validator stays untouched). */
function frontmatterSupersedes(absFile: string): string | undefined {
  const src = readFileSync(absFile, "utf8");
  if (!src.startsWith("---\n")) return undefined;
  const end = src.indexOf("\n---\n", 4);
  if (end === -1) return undefined;
  const m = /^supersedes:\s*(.*)$/m.exec(src.slice(4, end));
  return m ? m[1].trim() : undefined;
}

/** Group the queue's next-goal files by exact bytes; each group keeps its newest filename. */
export function byteDuplicateGroups(outputDir: string): Array<{ newest: string; duplicates: string[] }> {
  const files = existsSync(outputDir)
    ? readdirSync(outputDir)
        .filter((f) => NEXT_GOAL_FILENAME_RE.test(f) && lstatSync(join(outputDir, f)).isFile())
        .sort()
    : [];
  const byBytes = new Map<string, string[]>();
  for (const f of files) {
    const key = readFileSync(join(outputDir, f), "utf8");
    const list = byBytes.get(key);
    if (list) list.push(f);
    else byBytes.set(key, [f]);
  }
  const groups: Array<{ newest: string; duplicates: string[] }> = [];
  for (const names of byBytes.values()) {
    if (names.length < 2) continue;
    // files[] is sorted, so the last name is the newest filename.
    groups.push({ newest: names[names.length - 1], duplicates: names.slice(0, -1) });
  }
  return groups;
}

export function planRepoint(outputDir: string, requestedTarget: string): RepointPlan {
  const requested = resolve(requestedTarget);
  const groups = byteDuplicateGroups(outputDir);
  const deletions: DupDeletion[] = [];
  for (const g of groups) {
    for (const dup of g.duplicates) deletions.push({ file: join(outputDir, dup), newerTwin: g.newest });
  }

  // Re-target when the requested file is itself a stale duplicate (the live case).
  const staleTwin = groups.find((g) => g.duplicates.some((d) => join(outputDir, d) === requested));
  const retargeted = staleTwin
    ? {
        from: requested,
        to: join(outputDir, staleTwin.newest),
        reason: `requested target is a byte-duplicate of newer ${staleTwin.newest} — re-targeted (newest-filename wins)`,
      }
    : false;
  const resolvedTarget = retargeted ? retargeted.to : requested;

  const validation = existsSync(resolvedTarget) ? validateNextGoalFile(resolvedTarget) : undefined;

  // Supersedes honesty: any `supersedes:` predecessor filename must be strictly
  // older than the target's own filename timestamp (`none` = first file ever).
  const supersedesOrder = { ok: true, detail: undefined as string | undefined };
  const targetTs = filenameTs(basename(resolvedTarget));
  const supersedes = existsSync(resolvedTarget) ? frontmatterSupersedes(resolvedTarget) : undefined;
  if (targetTs && supersedes && supersedes !== "none") {
    const predTs = filenameTs(basename(supersedes));
    if (predTs && predTs >= targetTs) {
      supersedesOrder.ok = false;
      supersedesOrder.detail = `supersedes ${basename(supersedes)} (${predTs}) is NOT older than the target (${targetTs}) — the chain must run oldest→newest`;
    }
  }

  return {
    outputDir,
    requestedTarget: requested,
    resolvedTarget,
    retargeted,
    validation,
    supersedesOrder,
    deletions,
  };
}

export function execRepoint(plan: RepointPlan, opts: { check: boolean }): RepointResult {
  const problems: string[] = [];
  const result: RepointResult = {
    ...plan,
    ok: false,
    checkOnly: opts.check,
    deleted: [],
    repointed: false,
    latestForm: "untouched",
    doctor: undefined,
    problems,
  };

  if (!existsSync(plan.resolvedTarget)) {
    problems.push(`target not found: ${plan.resolvedTarget}`);
    return result;
  }
  if (plan.validation && !plan.validation.ok) {
    problems.push(
      `target fails strict validation: ${plan.validation.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`)
        .join("; ")}`,
    );
  }
  if (!plan.supersedesOrder.ok) problems.push(`supersedes-order: ${plan.supersedesOrder.detail}`);
  if (problems.length > 0) return result; // a failed repoint destroys nothing

  // Deletions (never the resolved target — it is a group's newest by construction).
  if (!opts.check) {
    for (const d of plan.deletions) {
      if (d.file === plan.resolvedTarget) continue;
      unlinkSync(d.file);
      result.deleted.push(d);
    }
  }

  // Repoint as a RELATIVE SYMLINK (tmp + rename = atomic on the same fs).
  // The doctor models LATEST as a symlink (readlink-or-missing), so a symlink
  // is the only form it can health-check; if the artifact was previously a
  // regular content file, the switch is REPORTED, never silent.
  const latestPath = join(plan.outputDir, "LATEST-next-goal.md");
  const prevWasContentFile = (() => {
    try {
      return existsSync(latestPath) && !lstatSync(latestPath).isSymbolicLink();
    } catch {
      return false;
    }
  })();
  if (!opts.check) {
    const tmp = join(plan.outputDir, ".LATEST-next-goal.md.repoint-tmp");
    symlinkSync(basename(plan.resolvedTarget), tmp);
    renameSync(tmp, latestPath);
    result.repointed = true;
    result.latestForm = "symlink";
    if (prevWasContentFile) {
      problems.push(
        "note: LATEST-next-goal.md was a regular content file — repointed as a symlink (the only form doctorNextGoal can health-check); form switch is deliberate",
      );
    }
  } else {
    result.latestForm = "untouched";
  }

  result.doctor = doctorNextGoal(plan.outputDir);
  result.ok = true;
  return result;
}
