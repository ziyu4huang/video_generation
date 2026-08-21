/**
 * workflow-pack-id.ts — stable pack identity (decision 08).
 *
 * `packId = <name-slug>-<sha256(absolutePath).slice(0,12)>`. Version-INDEPENDENT
 * (bumping manifest `version` never changes packId, so it never orphans
 * runs/outputs). Disambiguates same-named packs across locations. Mirrors
 * `workflowProjectKey` (slug-hash) in workflow-paths.ts. Pure — no fs, no network.
 */
import { createHash } from "node:crypto";

/** Slugify a pack name: lowercase, non-[a-z0-9._-] → dash, trimmed, capped. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "pack";
}

export function packId(name: string, absPath: string): string {
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 12);
  return `${slugify(name)}-${hash}`;
}
