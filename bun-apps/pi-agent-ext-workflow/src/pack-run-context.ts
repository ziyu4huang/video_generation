/**
 * pack-run-context.ts — resolve a pack's runtime filesystem context (decisions 03/07/12).
 *
 * Pure packaging over the PR-#689 primitives (packStateRoot / ensureStateDirs / packId):
 * given a pack's identity (name + packDir + optional manifest) and the repo root, derive
 * the single state root + its runs/outputs/intermediate dirs + the manifest io contract.
 * The tool layer calls this once per pack run and passes the result DOWN to the manager
 * as ExecOptions — the engine (runWorkflow) never imports pack concepts.
 */
import { join } from "node:path";
import { packId } from "./workflow-pack-id.js";
import { packStateRoot, ensureStateDirs } from "./pack-state.js";
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
