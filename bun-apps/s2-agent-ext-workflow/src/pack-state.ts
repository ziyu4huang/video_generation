/**
 * pack-state.ts — resolve a pack's runtime-state root (decisions 03/07).
 *
 * `.pi/workflows/<name>` packs → state is IN-PLACE inside the pack folder
 * (redirected=false). Checked-in packs (`bun-apps/<pkg>/workflows/<name>`,
 * which can't hold writable state) → redirect runtime state to
 * `<repoRoot>/.pi/workflows/.state/<packId>/` — project-local, NEVER `~/.pi`
 * (honors 03 / ADR-0001). Static pack files (manifest/entry/agents) stay in the
 * package dir; only runs/outputs/intermediate redirect. Lazy self-provisioning:
 * `ensureStateDirs` mkdir -p's runs/outputs/intermediate idempotently.
 */
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { packId } from "./workflow-pack-id.js";

const PI_WORKFLOWS = join(".pi", "workflows");

export function packStateRoot(args: { packDir: string; name: string; repoRoot: string }): {
  root: string;
  redirected: boolean;
} {
  const piWorkflowsRoot = join(args.repoRoot, PI_WORKFLOWS);
  const relToPi = relative(piWorkflowsRoot, args.packDir);
  const relToRoot = relative(args.repoRoot, args.packDir);
  // In-place iff packDir lives under <repoRoot>/.pi/workflows/... (not escaped).
  if (relToPi && !relToPi.startsWith("..") && !relToRoot.startsWith("..")) {
    return { root: args.packDir, redirected: false };
  }
  const id = packId(args.name, args.packDir);
  return { root: join(piWorkflowsRoot, ".state", id), redirected: true };
}

export function ensureStateDirs(stateRoot: string): void {
  for (const d of ["runs", "outputs", "intermediate"]) {
    mkdirSync(join(stateRoot, d), { recursive: true });
  }
}
