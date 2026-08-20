/**
 * s2-agent-ext-superpowers — Pi-native port of Superpowers (Primer Radiant).
 *
 * The default factory is intentionally thin: it wires the two upstream
 * behaviors (skill discovery via `resources_discover` + `using-superpowers`
 * bootstrap injection) implemented in `./superpowers.ts`. There are no slash
 * commands and no coordination globals — unlike s2-agent-ext-wayfind, the
 * Superpowers runtime is skill-driven, not command-driven.
 *
 * Pure TypeScript: no python3, no shell. Loaded by Pi via the `pi.extensions`
 * manifest in package.json; all logic lives in `src/`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { superpowersExtension } from "./superpowers.js";

export default function superpowersPiExtension(pi: ExtensionAPI): void {
  superpowersExtension(pi);
}

export {
  _resetBootstrapCacheForTests,
  BOOTSTRAP_MARKER,
  getBootstrapContent,
  parseSkillExclude,
  resolveAdvertisedSkillPaths,
  resolveBootstrapSkillPath,
  resolveSkillsDir,
  SKILL_EXCLUDE_ENV,
  superpowersExtension,
} from "./superpowers.js";
