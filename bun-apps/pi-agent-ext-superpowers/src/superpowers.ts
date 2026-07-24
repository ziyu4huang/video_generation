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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi";

export { BOOTSTRAP_MARKER };

/**
 * True when `fromUrl` is inside Bun's compiled-binary virtual filesystem
 * ($bunfs, or its ~BUN / URL-encoded %7EBUN variants). Same marker check as
 * pi-agent/src/mode.ts isBunBinary() — inlined here to keep this package
 * dependency-free of pi-agent.
 */
function isBunBinaryUrl(fromUrl: string): boolean {
  return fromUrl.includes("$bunfs") || fromUrl.includes("~BUN") || fromUrl.includes("%7EBUN");
}

/**
 * Resolve the package's `skills/` directory from this compiled module's URL.
 * Works whether the entry runs from `src/` (tsx/dev) or `dist/` (built) because
 * the `skills/` dir is a sibling of both under the package root
 * (`<pkg>/src|dist/...` → `<pkg>/skills`).
 *
 * Compiled-binary mode (`bun build --compile`): the module URL is a $bunfs
 * virtual path, so `../skills` resolves to a path that does not exist on the
 * real filesystem. pi-agent's extract-embedded-assets patch extracts the real
 * skills to $BUN_PI_EMBEDDED_EXTRACT_DIR/pi-agent-ext-superpowers/skills (the
 * same dir its run-dir resolver passes via `--skill`, so pi dedups the two) —
 * resolve there instead.
 */
export function resolveSkillsDir(fromUrl: string = import.meta.url): string {
  if (isBunBinaryUrl(fromUrl)) {
    const extractDir = process.env.BUN_PI_EMBEDDED_EXTRACT_DIR;
    if (extractDir) return join(extractDir, "pi-agent-ext-superpowers", "skills");
  }
  const moduleDir = dirname(fileURLToPath(fromUrl));
  // src/superpowers.ts → ../skills ; dist/superpowers.js → ../skills
  return resolve(moduleDir, "..", "skills");
}

/** Path to the bootstrap skill, resolved relative to a caller module URL. */
export function resolveBootstrapSkillPath(fromUrl: string = import.meta.url): string {
  return resolve(resolveSkillsDir(fromUrl), "using-superpowers", "SKILL.md");
}

/**
 * Register the Superpowers Pi extension. The default export of `src/index.ts`
 * (and the thin `extensions/index.ts` wrapper) calls this.
 */
export function superpowersExtension(pi: ExtensionAPI, fromUrl: string = import.meta.url): void {
  const skillsDir = resolveSkillsDir(fromUrl);
  let injectBootstrap = true;

  // Never advertise a non-existent dir (e.g. a classic --compile binary with no
  // embedded-assets extraction): pi reports each missing skill path as a
  // "[Skill conflicts] skill path does not exist" startup warning.
  pi.on("resources_discover", async () => ({
    skillPaths: existsSync(skillsDir) ? [skillsDir] : [],
  }));

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
export function getBootstrapContent(fromUrl: string = import.meta.url): string | null {
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

Pi's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, plus optional \`grep\`, \`find\`, and \`ls\`. Use those for the corresponding actions: read a file, create or edit files, run shell commands, search file contents, find files by name, and list directories.

Pi does not ship a standard subagent tool in core. This repo's pi-agent-ext-subagent provides a 'subagent' tool - an isolated-context child dispatch (subagent({ task, model?, tier?, tools?, excludeTools?, cwd?, commitScope?, tokenBudget?, spendBudget?, timeoutMs?, schema?, agentType? }); the child has no access to this session's history, so pass a self-contained 'task'). Superpowers subagent workflows (subagent-driven-development) use it. Directives every dispatch: (1) prefer tier ('small'|'medium'|'big', resolved from ~/.pi/workflows/model-tiers.json via /workflows-models) over a raw model id - it is portable and user-tunable; SDD roles: implementer=medium, research=small, synthesis/big. (2) For an SDD implementer/fix dispatch, pass commitScope with the task's declared file scope (e.g. ["src/auth/","tests/auth/"]) so the tool flags any out-of-scope committed path - the recurring 'git add -A' sweep that stages .planning/<effort>/sdd/ scratch into a commit, which then lands on main at squash-merge - as a warning (detection only; you decide the revert). Use [] for a read-only subagent that should commit nothing. (3) The tool auto-parses the SDD implementer's '**Status:** DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED' block into details.report, and auto-persists each completed run to ~/.pi/subagents/runs/. (4) For CONCURRENT fan-out (dispatching-parallel-agents), use the 'workflow' tool's parallel() - NOT multiple subagent calls in one turn (the subagent tool is executionMode: sequential, so a batch of them serializes). For the full param surface + rationale (schema, agentType, retryOnTransient, tokenBudget/spendBudget guidance), read references/pi-tools.md. If no 'subagent' tool is available, do the work in this session or explain the missing capability instead of inventing Task calls.

Pi does not ship a standard task-list tool. If an installed todo/task tool is available, use it. Otherwise track work in plan files or a repo-local \`TODO.md\` when task tracking is needed. Treat older \`TodoWrite\` references as this task-tracking action.`;
}

function piBoundaryOverrides(): string {
  return `## Path & routing overrides (this repo)

Superpowers and Wayfind are two parallel, non-connecting pipelines that share the \`.planning/<effort>/\` layout. Three runtime rules keep them from colliding; apply them in addition to the skill bodies (which keep their upstream text verbatim).

**1. Artifact-home override.** When a Superpowers skill tells you to save a spec under \`docs/superpowers/specs/\` or a plan under \`docs/superpowers/plans/\`, write it under the unified layout instead: \`docs/superpowers/specs/...\` → \`.planning/<effort>/spec.md\`; \`docs/superpowers/plans/...\` → \`.planning/<effort>/plan.md\`. This converges the homes at runtime without forking the upstream skill text.

**2. Entry-path routing.** The discriminator for which pipeline to enter is *can I write a plan right now from what's already settled?* — **yes** (spec/requirements in hand, route clear) → Superpowers (\`brainstorming\` → \`writing-plans\`, any size; huge handled via sub-project decomposition); **no** (decisions still open, route foggy) → Wayfind (\`wayfinder\` if the effort is huge/multi-session, else \`grilling\`). When a Wayfind decide-phase (\`grilling\`/\`wayfinder\`) has already settled the decisions, \`brainstorming\` defers to \`to-spec\` (synthesize what's settled — do not re-explore).

**3. SDD workspace override.** The subagent-driven-development skill and its sdd-workspace script reference .superpowers/sdd/ (task briefs, implementer reports, review packages, and the compaction-recovery progress ledger). On pi, redirect ALL of that under the effort layout instead: .superpowers/sdd/... → .planning/<effort>/sdd/... — briefs under .planning/<effort>/sdd/briefs/, implementer reports under reports/, review packages under reviews/, and the progress ledger at .planning/<effort>/sdd/progress.md. Derive <effort> from the plan you are executing (.planning/<effort>/plans/<plan>.md). mkdir -p the subdirs on first use; append one line per task to progress.md on review-clean (Task N: complete (commits <base7>..<head7>, review clean)) and read it at SDD start to skip completed tasks. Do NOT call the byte-identical sdd-workspace script (it returns .superpowers/sdd); use the effort layout directly. This converges the SDD runtime workspace beside the effort's map/tickets/plan without forking the upstream skill text.`;
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
