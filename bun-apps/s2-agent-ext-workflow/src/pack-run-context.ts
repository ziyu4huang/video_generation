/**
 * pack-run-context.ts — resolve a pack's runtime filesystem context (decisions 03/07/12).
 *
 * Pure packaging over the PR-#689 primitives (packStateRoot / ensureStateDirs / packId):
 * given a pack's identity (name + packDir + optional manifest) and the repo root, derive
 * the single state root + its runs/outputs/intermediate dirs + the manifest io contract.
 * The tool layer calls this once per pack run and passes the result DOWN to the manager
 * as ExecOptions — the engine (runWorkflow) never imports pack concepts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDirs, packStateRoot } from "./pack-state.js";
import { packId } from "./workflow-pack-id.js";
import type { Manifest, ManifestIo } from "./workflow-pack-manifest.js";

export interface PackRunContext {
  packId: string;
  stateRoot: string;
  redirected: boolean;
  runsDir: string;
  outputsDir: string;
  intermediateDir: string;
  io?: ManifestIo;
}

export function resolvePackRunContext(args: {
  name: string;
  packDir: string;
  manifest?: Manifest;
  repoRoot: string;
}): PackRunContext {
  const { root, redirected } = packStateRoot({
    packDir: args.packDir,
    name: args.name,
    repoRoot: args.repoRoot,
  });
  ensureStateDirs(root);
  return {
    packId: packId(args.name, args.packDir),
    stateRoot: root,
    redirected,
    runsDir: join(root, "runs"),
    outputsDir: join(root, "outputs"),
    intermediateDir: join(root, "intermediate"),
    io: args.manifest?.io,
  };
}

/**
 * Mirror one journal entry to the disposable on-disk intermediate tree (decision 12).
 * Layout: <intermediateDir>/<phase|_no-phase>/<index>-<hash>.<ext>. The journal stays
 * the resume source-of-truth; this file is purely for agent inspection and is safe to
 * purge at any time. Best-effort: a write failure is swallowed so it can never break a run.
 */
export function mirrorIntermediate(
  intermediateDir: string,
  phase: string | undefined,
  entry: { index: number; hash: string; result: unknown },
): void {
  try {
    const phaseDir = join(intermediateDir, phase || "_no-phase");
    mkdirSync(phaseDir, { recursive: true });
    const isText = typeof entry.result === "string";
    const ext = isText ? "txt" : "json";
    const content = isText ? String(entry.result) : JSON.stringify(entry.result, null, 2);
    writeFileSync(join(phaseDir, `${entry.index}-${entry.hash}.${ext}`), content);
  } catch {
    // Disposable mirror (decision 12): never let a side-write break the run.
  }
}
