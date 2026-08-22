/**
 * s2-agent-ext-superpowers — Pi-native port of Superpowers (Primer Radiant).
 *
 * Pure named-export barrel over `./superpowers.ts` (all logic lives there;
 * the Pi entry is `extensions/superpowers.ts`, which imports the factory
 * directly). There are no slash commands and no coordination globals — unlike
 * s2-agent-ext-wayfind, the Superpowers runtime is skill-driven, not
 * command-driven.
 *
 * Pure TypeScript: no python3, no shell. Loaded by Pi via the `pi.extensions`
 * manifest in package.json; all logic lives in `src/`.
 */

export {
  _resetBootstrapCacheForTests,
  BOOTSTRAP_MARKER,
  DEFAULT_SKILL_EXCLUDE,
  getBootstrapContent,
  parseSkillExclude,
  SKILL_EXCLUDE_ENV,
  superpowersExtension,
} from "./superpowers.js";
