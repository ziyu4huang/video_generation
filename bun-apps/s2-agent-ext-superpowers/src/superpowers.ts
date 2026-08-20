/**
 * Superpowers bootstrap logic — Pi port of upstream
 * `superpowers/.pi/extensions/superpowers.ts`.
 *
 * Two responsibilities, unchanged from upstream:
 *   1. `resources_discover` → hand Pi the package's `skills/` dir so all 14
 *      skills load natively.
 *   2. Inject the `using-superpowers` bootstrap into context once per
 *      session/compaction (until the first `agent_end`), unless the bootstrap
 *      is already present in the visible messages. The bootstrap carries the
 *      skill body + a Pi tool-mapping note so the agent treats Superpowers as
 *      already-loaded instead of re-reading the skill.
 *
 * Pure TS: no python, no shell. File-system access is a single read of the
 * bootstrap SKILL.md (cached). Deterministic — no LLM, no network.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi";

/** Env var holding a comma-list of skill dir-names to UNREGISTER (Phase-3).
 *  See {@link parseSkillExclude} / {@link resolveAdvertisedSkillPaths}. */
export const SKILL_EXCLUDE_ENV = "PI_SUPERPOWERS_SKILL_EXCLUDE";

/**
 * Skills UNREGISTERED by default (never advertised via `resources_discover`),
 * each for a distinct reason — see ADR-0008 for the full policy. (Advertisement
 * cost = `<name>`+`<description>`+`<location>` injected per skill by pi core's
 * `formatSkillsForPrompt`; bodies are read on-demand, never injected by
 * advertisement.)
 *   - `verification-before-completion` (~121 tok advertisement) — Phase-3
 *     clean-pass: the model resists confidence-escalation even without this
 *     skill, so dropping it costs ~zero behavior.
 *   - `using-superpowers` (~96 tok advertisement) — bootstrap dedup: its full
 *     body is already injected as the bootstrap by {@link getBootstrapContent},
 *     which also instructs the agent not to load it again, so advertising it
 *     is a redundant pointer for ~zero behavioral gain.
 * Override via the env list ({@link SKILL_EXCLUDE_ENV}), or disable the
 * defaults entirely via {@link DEFAULTS_DISABLE_ENV}.
 */
export const DEFAULT_SKILL_EXCLUDE = ["verification-before-completion", "using-superpowers"] as const;

/** Set to `0`/`false`/`no`/`off` to suppress {@link DEFAULT_SKILL_EXCLUDE} —
 *  e.g. for a probe fat-run that must load every skill, or to restore the
 *  historical "load all skills" behavior. */
export const DEFAULTS_DISABLE_ENV = "PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS";

export { BOOTSTRAP_MARKER };

/**
 * True when `fromUrl` is inside Bun's compiled-binary virtual filesystem
 * ($bunfs, or its ~BUN / URL-encoded %7EBUN variants). Same marker check as
 * s2-agent/src/mode.ts isBunBinary() — inlined here to keep this package
 * dependency-free of s2-agent.
 */
function isBunBinaryUrl(fromUrl: string): boolean {
  return fromUrl.includes("$bunfs") || fromUrl.includes("~BUN") || fromUrl.includes("%7EBUN");
}

/**
 * This extension's deployed directory under the sh loader, when running there.
 *
 * bun's cjs bundler REBINDS `__dirname`/`__filename` inside an extension bundle
 * to the paths the source had on the BUILD MACHINE, and folds `import.meta.url`
 * into a build-machine path literal — so neither is relocatable. The sh loader
 * instead serves the extension's real deployed dir (`ext/<name>/`) through the
 * injected require under the reserved pseudo-specifier below. Throws → returns
 * undefined everywhere else (jiti/source, native ESM, tests).
 */
const EXT_DIR_SPEC = "#pi/ext-dir";

function shExtDir(): string | undefined {
  try {
    if (typeof require === "function") {
      const mod = require(EXT_DIR_SPEC) as { default?: unknown } | string;
      if (typeof mod === "string") return mod; // sh loader: the deployed ext dir
      if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
        return mod.default; // jiti/source: package.json "#pi/ext-dir" imports entry
      }
    }
  } catch {
    // Not resolvable here (native ESM / tests) — fall through.
  }
  return undefined;
}

/**
 * Resolve the package's `skills/` directory.
 *
 * Deliberately does NOT default to `import.meta.url`: bun's cjs bundler folds
 * it into a build-machine path literal (which the sh deploy's relocatability
 * gate rejects), and an unfolded `import.meta` is a SyntaxError inside the sh
 * loader's cjs wrapper. Resolution order:
 *
 *   1. Compiled-binary mode (`bun build --compile`, detected via the
 *      BUN_PI_EMBEDDED_EXTRACT_DIR env the extract-embedded-assets patch sets
 *      before extensions load): skills are extracted to
 *      $BUN_PI_EMBEDDED_EXTRACT_DIR/s2-agent-ext-superpowers/skills (the same
 *      dir the run-dir resolver passes via `--skill`, so pi dedups the two).
 *   2. sh deploy (cjs bundle): `require("#pi/ext-dir")` → skills/ ships beside
 *      the bundle (ext/<name>/skills).
 *   3. jiti/source and dist: the package.json `"#pi/ext-dir"` imports entry
 *      (`src/sh-ext-dir.ts`, loaded by jiti as cjs with the REAL `__dirname`)
 *      → the package root, where `skills/` lives.
 *
 * `fromUrl` stays injectable for tests and for callers that DO have a valid
 * module URL (e.g. inside s2-agent's own --compile binary, where
 * `import.meta.url` is the $bunfs virtual path).
 */
export function resolveSkillsDir(fromUrl?: string): string {
  const extractDir = process.env.BUN_PI_EMBEDDED_EXTRACT_DIR;
  if (extractDir && (fromUrl === undefined || isBunBinaryUrl(fromUrl))) {
    return join(extractDir, "s2-agent-ext-superpowers", "skills");
  }
  if (fromUrl !== undefined) {
    // src/superpowers.ts → ../skills ; dist/superpowers.js → ../skills
    return resolve(dirname(fileURLToPath(fromUrl)), "..", "skills");
  }
  const extDir = shExtDir();
  if (extDir !== undefined) return join(extDir, "skills");
  throw new Error(
    "resolveSkillsDir: cannot locate skills/ (no fromUrl injected, no BUN_PI_EMBEDDED_EXTRACT_DIR, no #pi/ext-dir)",
  );
}

/** Path to the bootstrap skill, resolved relative to a caller module URL. */
export function resolveBootstrapSkillPath(fromUrl?: string): string {
  return resolve(resolveSkillsDir(fromUrl), "using-superpowers", "SKILL.md");
}

/**
 * Resolve the exclude set = {@link DEFAULT_SKILL_EXCLUDE} (Phase-3 clean-pass,
 * unless suppressed) ∪ the `PI_SUPERPOWERS_SKILL_EXCLUDE` comma-list. Whitespace
 * is trimmed and empty tokens dropped, so `" a ,, b "` adds `a`,`b` on top of
 * the defaults. Set `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` to suppress the
 * defaults entirely (e.g. a probe fat-run that must load every skill).
 *
 * Phase-3 skill-unload audit: any listed skill is dropped from the
 * `resources_discover` advertisement so pi never registers it, WITHOUT editing
 * the pinned `SKILL.md` (ADR-0004 — unregister ≠ edit). Pure + injectable so
 * the unit test can drive it without touching `process.env` ordering.
 */
export function parseSkillExclude(env: Record<string, string | undefined> = process.env): Set<string> {
  // DEFAULT_SKILL_EXCLUDE applies unless explicitly suppressed (Phase-3 default-off).
  const defaultsOff = /^(0|false|no|off)$/i.test(env[DEFAULTS_DISABLE_ENV] ?? "");
  const defaults = defaultsOff ? [] : DEFAULT_SKILL_EXCLUDE;
  const fromEnv = (env[SKILL_EXCLUDE_ENV] ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return new Set([...defaults, ...fromEnv]);
}

/** Immediate skill-dir names actually present under `skillsDir` (the keys the
 *  exclude list is matched against). Sorted for stable output. Never throws. */
function listSkillDirNames(skillsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      try {
        return statSync(join(skillsDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Resolve the `resources_discover` advertisement for a skills dir, honoring
 * the exclude knob.
 *
 * - Exclude EMPTY  → `[skillsDir]` (pi recurses into every `<name>/` itself;
 *   this is the historical behavior and preserves the silent dedup vs the
 *   run-dir `--skill <skillsDir>` splice — both resolve to the same real dir).
 * - Exclude NON-empty → the INDIVIDUAL skill-dir paths for every present skill
 *   NOT in the exclude set. Each `<name>/` is a pi skill root (a dir whose
 *   direct child `SKILL.md` makes pi treat it as a skill root and stop
 *   recursing), so pi registers exactly that skill from each path and the
 *   excluded skill is never registered.
 *
 * NB: for the exclude to actually take effect at runtime, this extension must
 * be the SOLE skill source. The run-dir resolver splices `--skill <skillsDir>`
 * into argv (which loads every skill before this handler runs, silently deduped
 * to the same real files), so a real `pi -p` thin run must ALSO pass `-ns`
 * (`--no-skills`) to suppress that splice — then skills load only via this
 * handler and the knob is authoritative. See `scripts/probe-runner.ts` `--ab-skill`.
 */
export function resolveAdvertisedSkillPaths(skillsDir: string, exclude: Set<string> = parseSkillExclude()): string[] {
  if (exclude.size === 0) return [skillsDir];
  return listSkillDirNames(skillsDir)
    .filter((name) => !exclude.has(name))
    .map((name) => join(skillsDir, name));
}

/**
 * Register the Superpowers Pi extension. The default export of `src/index.ts`
 * (and the thin `extensions/index.ts` wrapper) calls this.
 */
export function superpowersExtension(pi: ExtensionAPI, fromUrl?: string): void {
  // Self-gate: BUN_PI_SUPERPOWERS=0 disables the entire extension — no skill
  // advertisement (resources_discover), no bootstrap injection, no event hooks.
  // Mirrors prompt-history's BUN_PI_PROMPT_HISTORY=0 for a symmetric full-disable
  // across the core trio. This sits ABOVE the granular
  // PI_SUPERPOWERS_SKILL_EXCLUDE / PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS knobs,
  // which continue to filter advertised skills when the extension is ENABLED.
  if (process.env.BUN_PI_SUPERPOWERS === "0") return;
  const skillsDir = resolveSkillsDir(fromUrl);
  let injectBootstrap = true;

  // Never advertise a non-existent dir (e.g. a classic --compile binary with no
  // embedded-assets extraction): pi reports each missing skill path as a
  // "[Skill conflicts] skill path does not exist" startup warning.
  //
  // PI_SUPERPOWERS_SKILL_EXCLUDE (Phase-3): a comma-list of skill dir-names to
  // UNREGISTER (omitted from the advertisement) without touching their pinned
  // SKILL.md (ADR-0004). The exclude set also includes DEFAULT_SKILL_EXCLUDE
  // (verification-before-completion — Phase-3 clean-pass) unless
  // PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0 suppresses it. The handler then
  // returns individual skill-dir paths so pi registers exactly the non-excluded
  // skills. Computed per-call (not captured at registration) so a subprocess can
  // flip the env between a fat run and a thin run in the same process image.
  pi.on("resources_discover", async () => {
    if (!existsSync(skillsDir)) return { skillPaths: [] };
    return { skillPaths: resolveAdvertisedSkillPaths(skillsDir) };
  });

  pi.on("session_start", async () => {
    injectBootstrap = true;
  });

  pi.on("session_compact", async () => {
    injectBootstrap = true;
  });

  pi.on("agent_end", async () => {
    injectBootstrap = false;
  });

  pi.on("context", async (event) => {
    if (!injectBootstrap) return;
    if (event.messages.some(messageContainsBootstrap)) return;

    const bootstrap = getBootstrapContent();
    if (!bootstrap) return;

    const bootstrapMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: bootstrap }],
      timestamp: Date.now(),
    };

    const insertAt = firstNonCompactionSummaryIndex(event.messages);
    return {
      messages: [...event.messages.slice(0, insertAt), bootstrapMessage, ...event.messages.slice(insertAt)],
    };
  });
}

let cachedBootstrap: string | null | undefined;

/** Read + assemble the bootstrap payload. Cached after first call. `fromUrl`
 *  is injectable so tests can point at the real skill without importing.meta. */
export function getBootstrapContent(fromUrl?: string): string | null {
  if (cachedBootstrap !== undefined) return cachedBootstrap;

  try {
    const skillContent = readFileSync(resolveBootstrapSkillPath(fromUrl), "utf8");
    const body = stripFrontmatter(skillContent);
    cachedBootstrap = `${EXTREMELY_IMPORTANT_MARKER}
${BOOTSTRAP_MARKER}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${body}

${piToolMapping()}

${piBoundaryOverrides()}
</EXTREMELY_IMPORTANT>`;
    return cachedBootstrap;
  } catch {
    cachedBootstrap = null;
    return null;
  }
}

/** Test-only escape hatch: reset the cached bootstrap so a fresh read happens. */
export function _resetBootstrapCacheForTests(): void {
  cachedBootstrap = undefined;
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

function piToolMapping(): string {
  return `## Pi tool mapping

Pi has native skills but does not expose Claude Code's \`Skill\` tool. When a Superpowers instruction says to invoke a skill, use Pi's native skill system instead: load the relevant \`SKILL.md\` with \`read\` when the skill applies, or let a human invoke \`/skill:name\` explicitly.

Pi has no core subagent tool; this repo's \`spawn_subagent\` tool (s2-agent-ext-subagent; renamed from \`subagent\` 2026-08-20 — docs/agents/extension-naming.md) is an isolated-context child dispatch — \`spawn_subagent({ task, model?, capability?, tier?, tools?, excludeTools?, cwd?, commitScope?, tokenBudget?, spendBudget?, timeoutMs?, schema?, agentType?, watchdog? })\`; the child has no access to this session's history, so pass a self-contained \`task\`. BEFORE any SDD implementer/fix dispatch, read \`references/pi-tools.md\` for the load-bearing directives (prefer \`tier\` over a raw model id; pass \`commitScope\` for scope-detection; pass \`watchdog:{l2:true}\` for adversarial review; use the \`run_workflow\` tool's \`parallel()\` for concurrent fan-out, since \`spawn_subagent\` is sequential). If no \`spawn_subagent\` tool is available, do the work in this session — never invent \`Task\` calls.`;
}

function piBoundaryOverrides(): string {
  return `## Pipeline routing (this repo)

Superpowers and Wayfind share the \`.planning/<effort>/\` layout. Two rules:

**1. One canonical home.** Every artifact lives under \`.planning/<effort>/\`: specs → \`.planning/<effort>/spec.md\`, plans → \`.planning/<effort>/plan.md\`, the SDD workspace → \`.planning/<effort>/sdd/<plan-basename>/\` (briefs/reports/reviews + recovery ledger at \`.planning/<effort>/sdd/<plan-basename>/progress.md\`), brainstorm mockups → \`.planning/<effort>/brainstorm/\`. \`scripts/sdd-workspace PLAN_FILE\` resolves the plan's dir and honors \`PI_PLANNING_EFFORT\`. No-effort specs/plans land in \`.planning/specs/\`/\`.planning/plans/\`; \`.planning/\` is the sole artifact home — no artifact is ever written outside it (no-effort SDD → flat, gitignored \`.planning/sdd/\`).

**2. Pick the pipeline by stage — check what's on disk first.**

| Stage | Trigger (check disk) | Pipeline |
|---|---|---|
| DECIDE | no spec, decisions open / route foggy | Wayfind — grilling (or /wayfind) |
| SYNTHESIZE | grill just settled; spec needed | Wayfind — to-spec (synthesize only) |
| DESIGN | requirement clear, zero open decisions | Superpowers — brainstorming |
| PLAN | spec exists, no plan | Superpowers — writing-plans |
| EXECUTE | plan exists | Superpowers — executing-plans / SDD |

Four of five stages are a disk check; only DECIDE-vs-DESIGN needs judgment. When in doubt, DECIDE first.`;
}

function messageContainsBootstrap(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    return (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.includes(BOOTSTRAP_MARKER)
    );
  });
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
  let index = 0;
  while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") {
    index += 1;
  }
  return index;
}
