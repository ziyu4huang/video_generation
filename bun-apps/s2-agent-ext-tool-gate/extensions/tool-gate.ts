/// <reference types="@repo/s2-agent-core-interface" />
/**
 * Dynamic Tool Gate Extension — reduces API tools schema overhead
 *
 * Keeps core tools always active while gating heavy domain-specific tools
 * behind prompt keyword matching. Every gate is owner-declared via `gating` on
 * the owning tool's def (tickets 03–12 migrated flux2/ltx/krea2/movie/
 * research-tool/workflow/subagent/inspect/zai-mcp off the former hardcoded
 * GATES array; ticket 15 deleted that now-empty array — no legacy fallback).
 * (deploy_pi_agent_sh/verify_pi_agent_deploy migrated to owner-declared gating in ticket 03;
 *  file2md/vision_ask migrated to owner-declared gating in ticket 04;
 *  flux2/flux2_help migrated to owner-declared gating in ticket 05;
 *  krea2/krea2_help migrated to owner-declared gating in ticket 06;
 *  ltx/ltx_help migrated to owner-declared gating in ticket 07;
 *  movie/movie_help migrated to owner-declared gating in ticket 08;
 *  research-tool's collect_videos/organize_vault_notes/import_memory_to_vault
 *  + arxiv_search/arxiv_fetch2md/arxiv_paper migrated in ticket 09;
 *  workflow/workflow_help/subagent/workflow_control migrated in tickets 10 + 11,
 *  rolled out TOGETHER as one atomic unit over their single shared combined gate.)
 *
 * Baseline:  ~72 tools → ~21,950 tok/req   (measured via `bun run qa`)
 * Gated:    ON at start ~6,750 tok/req   (saves ~15,186 tok/turn, ~69%; net ~14,900; zai-mcp env-gated)
 *
 * Tools reactivate instantly when the prompt mentions relevant keywords, and
 * once activated stay active for the rest of the session (they never re-gate
 * on a later turn).
 *
 * Install: registered in bun-apps/s2-agent/src/run-dir/manifest.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ALL_TOOL_DEFINITIONS_GLOBAL,
  GATE_DEFS,
  publishSeam,
  readAllToolDefinitions,
  type Gate,
  type Gating,
  type ToolGateStatus,
} from "@repo/s2-agent-core-interface";
import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import { estimateToolCost } from "@repo/s2-agent-ext-power-tool/schema-cost";

// ── Tool categories ──────────────────────────────────────────────

/** Co-occurrence trigger: a gate fires when the prompt has ≥1 noun AND ≥1 verb.
 *  Used only for core nouns (image/video/pdf) whose bare form false-fires
 *  (docker image, video call) but whose recall on common intents
 *  (generate an image, make a video) must survive. */
export interface CoOccurrence {
  nouns: string[];
  verbs: string[];
}

export interface ToolGate {
  names: string[];
  /** Unambiguous triggers — matched via matchesKeyword. */
  keywords: string[];
  /** One-line description — used for enable_tool intent matching + list output. */
  description: string;
  /** Optional co-occurrence trigger (noun ∧ verb). See CoOccurrence. */
  requires?: CoOccurrence;
  /** Gate-family id when this gate was declared via the reference form
   *  (`gating: { gate: id }`, wayfinder ticket 01). Sibling tools share one id;
   *  every non-core gate carries one (the inline form was deleted in 01c).
   *  Lets consumers (enable_tool, introspection) group by identity. */
  gateId?: string;
}

/** The 4 pi-coding-agent built-in tools that tool-gate treats as always-active
 *  core. Ticket 03 (Path B, chosen at ticket 01): pi-coding-agent is an IMMUTABLE
 *  dependency and `gating` is a tool-gate-extension-only concept — the harness's
 *  `ToolDefinition` has no `gating` field — so these built-ins CANNOT be truly
 *  owner-declared in-repo (unlike the 14 in-repo tools done in ticket 02).
 *  Instead tool-gate INJECTS `gating:{ core: true }` onto their defs at runtime
 *  (see injectBuiltinCore), so buildEffectiveGates routes them into
 *  `effectiveCore` as owner-declared core.
 *
 *  This is *injected-core* (tool-gate supplies the field), NOT true
 *  owner-declaration; the cross-repo PR for true owner-declaration is deferred
 *  to FOLLOWUPS #5. Honest relocated residual: this set is the in-repo survival
 *  of a hardcoded built-in list (the last such list — ticket 04 deleted the
 *  former CORE_TOOLS hardcoded set; this BUILTIN_CORE remains only because the
 *  4 pi-coding-agent built-ins can't carry `gating` upstream). FOLLOWUPS #5
 *  (true upstreaming) is the only path that lets this set go too. */
export const BUILTIN_CORE = new Set(["read", "write", "edit", "bash"]);

/** Inject `gating:{ core: true }` onto the defs of the 4 pi-coding-agent
 *  built-ins (BUILTIN_CORE). Called by getDiscovered before buildEffectiveGates,
 *  so the built-ins land in `effectiveCore` as owner-declared core — the runtime
 *  end-state is identical (always-active).
 *
 *  Pure + defensive: SHALLOW-CLONES each built-in def (built-in def objects
 *  come from immutable pi-coding-agent and may be frozen) rather than mutating
 *  the upstream object; any pre-existing gating on a built-in is preserved and
 *  only `core` is forced true. Non-built-in defs pass through untouched (same
 *  reference); an already-`core:true` built-in is left as-is (idempotent). */
export function injectBuiltinCore<T extends { name: string; gating?: Gating }>(
  defs: T[],
): T[] {
  return defs.map((def) =>
    BUILTIN_CORE.has(def.name) && def.gating?.core !== true
      ? ({ ...def, gating: { ...(def.gating ?? {}), core: true } } as T)
      : def,
  );
}

/** Effective gate set built from owner-declared `gating`. */
export interface EffectiveGates {
  gates: ToolGate[];   // non-core gates: one per id-referenced gate family (multi-name)
  core: Set<string>;   // always-active names: owner-declared core:true
  tracked: Set<string>; // core ∪ all gate names — the explicit-track set for filterActive
}

/**
 * Build the effective gate set for a session from owner-declared `gating`:
 * authoritative, NO hardcoded fallback (ticket 04 deleted the former CORE_TOOLS
 * always-active set — every core member is now owner-declared via tickets 02 +
 * 03; ticket 15 earlier deleted the hardcoded GATES array). A `core:true` def →
 * always-active core; a def with `gating: { gate: "<id>" }` → a reference-form
 * gate; a def without `gating` is simply ungated. Pure: no pi dependency.
 *
 * Reference form (wayfinder ticket 01 — the ONLY non-core form since phase 01c
 * deleted the legacy inline keywords/requires shape): keywords/requires/
 * description are resolved from `gateDefs` (default: the shared `GATE_DEFS`
 * registry); every tool referencing the same id groups into ONE multi-name gate
 * (the co-firing family), in declaration order. An id absent from the registry
 * fails OPEN — the tool is treated as ungated (always active), matching the
 * standing fail-open posture; the drift-guard test catches such declaration
 * bugs at CI time (asserts every referenced id is known).
 */
export function buildEffectiveGates(
  defs: Array<{ name: string; description?: string; gating?: Gating }>,
  gateDefs: Record<string, Gate> = GATE_DEFS,
): EffectiveGates {
  const gates: ToolGate[] = [];
  const core = new Set<string>();
  const byId = new Map<string, ToolGate>(); // gate id → grouped family gate
  for (const def of defs) {
    const g = def.gating;
    if (!g) continue;
    if (g.core === true) {
      core.add(def.name);
      continue;
    }
    if (g.gate != null) {
      // Reference form: resolve the family spec from the registry once per id.
      const spec = gateDefs[g.gate];
      if (!spec) continue; // unknown id → fail-open (untracked, always active)
      let gate = byId.get(g.gate);
      if (!gate) {
        gate = {
          names: [],
          keywords: spec.keywords ?? [],
          requires: spec.requires,
          description: spec.description ?? def.description ?? "",
          gateId: g.gate,
        };
        byId.set(g.gate, gate);
        gates.push(gate);
      }
      gate.names.push(def.name);
    }
    // gating present but neither core nor a gate reference: invalid declaration
    // — ignored (fail-open), the drift-guard flags it at CI time.
  }
  const tracked = new Set<string>([...core, ...gates.flatMap((g) => g.names)]);
  return { gates, core, tracked };
}

/** Pure: filter `allToolNames` to those that should be active given `sticky`.
 *  Tools not in `tracked` are always active (fail-open); tracked tools
 *  are active only when present in `sticky`. Does NOT mutate sticky or
 *  evaluate gate keywords — gate firing is a separate concern.
 *
 *  `tracked` defaults to an empty set (everything fail-open); every runtime
 *  call site threads the session-built `EffectiveGates.tracked` explicitly. */
export function filterActive(
  allToolNames: string[],
  sticky: Set<string>,
  tracked: Set<string> = new Set<string>(),
): string[] {
  return allToolNames.filter((name) => !tracked.has(name) || sticky.has(name));
}

// ── Startup banner (obsidian-style above-editor widget) ──────────

/**
 * Schedule a transient above-editor banner (like the /goal banner): show once
 * after a short delay, then auto-dismiss. Mirrors s2-agent-ext-obsidian's
 * scheduleVaultBanner() and s2-agent-ext-zai-mcp's scheduleReadyBanner()
 * (commit 58a6b0b5). Uses setWidget (keyed "tool-gate") instead of notify() so
 * this extension's startup line never clobbers — or is clobbered by — other
 * extensions' messages: pi's notify("info", …) merges consecutive startup
 * notifies (later overwrites earlier), which previously made the tool-gate
 * confirmation line disappear depending on notify ordering.
 *
 * Both deferred ctx.ui calls are guarded: a session switch (/resume, ctx.fork,
 * ctx.switchSession) between schedule and fire leaves ctx stale, and ctx.ui's
 * assertActive() would otherwise throw an uncaughtException that crashes pi.
 * The banner is non-essential — a replacement session renders its own on its
 * own session_start — so swallow.
 *
 * `opts.immediate` skips the 5s show delay (debug). `opts.log` mirrors the
 * rendered lines to stderr so the trigger is observable where setWidget is a
 * no-op (print/RPC/noOpUIContext). Both default off; prod calls omit `opts`.
 */
// M6: pending banner timer ids across the process. Cleared at the top of each
// scheduleToolGateBanner call so a new session_start (/resume, ctx.fork)
// doesn't leave a prior session's show/dismiss timers running — all banners
// share the "tool-gate" widget key, so a stale show would flash the old
// session's lines and a stale dismiss would prematurely clear the new one.
let pendingBannerTimers: ReturnType<typeof setTimeout>[] = [];

export function scheduleToolGateBanner(
	ctx: { ui: { setWidget(key: string, lines: string[] | undefined): void } },
	lines: string[],
	opts?: { immediate?: boolean; log?: boolean },
): void {
	// Prod: delay 5s so the banner lands after the startup notify burst
	// (alongside zai-mcp's 5s banner, before obsidian's 10s vault banner — all
	// keyed widgets, so no collision; brief overlap shows confirmations together).
	// Debug (TOOL_GATE_DEBUG_BANNER): 0.
	const SHOW_DELAY_MS = opts?.immediate ? 0 : 5_000;
	const DISPLAY_MS = 8_000; // visible window before auto-dismiss (matches obsidian/zai-mcp)
	if (opts?.log) {
		// Mirror the rendered lines (incl. ANSI colors from theme.fg) to stderr so
		// the trigger + exact message are visible even where setWidget is a no-op
		// (print / RPC / noOpUIContext).
		console.error(`[tool-gate banner]\n${lines.join("\n")}`);
	}
	// M6: clear any banner timers still pending from a prior session_start.
	for (const id of pendingBannerTimers) clearTimeout(id);
	pendingBannerTimers = [];

	const showTimer = setTimeout(() => {
		try {
			ctx.ui.setWidget("tool-gate", lines);
		} catch {
			return; // ctx stale after session switch — banner is non-essential
		}
		// Auto-dismiss after DISPLAY_MS. Guarded the same way: a session switch
		// between show and dismiss leaves ctx stale.
		const dismissTimer = setTimeout(() => {
			try {
				ctx.ui.setWidget("tool-gate", undefined);
			} catch {
				/* ctx stale after session switch */
			}
			pendingBannerTimers = pendingBannerTimers.filter((id) => id !== dismissTimer);
		}, DISPLAY_MS);
		pendingBannerTimers.push(dismissTimer);
	}, SHOW_DELAY_MS);
	pendingBannerTimers.push(showTimer);
}

// ── Keyword matching (S2) ────────────────────────────────────────

/** Escape a string for safe embedding in a RegExp (prevents regex-injection
 *  from keyword/noun/verb content). */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `keyword` appear in the (already lowercased) prompt?
 *  - Single ASCII token (`^[a-z0-9]+$`): word-boundary match — prevents "flux"
 *    matching inside "conflux", "image" inside "images".
 *  - Multi-word phrase or CJK: substring (no word boundaries without a
 *    segmenter; phrases are specific enough once bare words are removed). */
// Hoisted: the single-ASCII-token type test is constant — compiling it per
// call (every gate × every keyword/noun/verb, every turn) was pure waste.
const ASCII_TOKEN_RE = /^[a-z0-9]+$/i;
// Cache of compiled word-boundary regexes, keyed by lowercased keyword. The
// keyspace is the finite owner-declared keyword/noun/verb set, so the cache is
// bounded; `new RegExp` per call on the hot per-turn path was the cost.
const wordBoundaryRegexCache = new Map<string, RegExp>();
function wordBoundaryRegex(kw: string): RegExp {
	let re = wordBoundaryRegexCache.get(kw);
	if (!re) {
		re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i");
		wordBoundaryRegexCache.set(kw, re);
	}
	return re;
}

export function matchesKeyword(keyword: string, promptLower: string): boolean {
	const kw = keyword.toLowerCase();
	if (ASCII_TOKEN_RE.test(keyword)) {
		return wordBoundaryRegex(kw).test(promptLower);
	}
	return promptLower.includes(kw);
}

/** A gate fires if any keyword matches, OR its `requires` co-occurrence
 *  (≥1 noun AND ≥1 verb) is met. Pure: no pi dependency. */
export function gateFires(gate: ToolGate, promptLower: string): boolean {
	if (gate.keywords.some((kw) => matchesKeyword(kw, promptLower))) return true;
	if (gate.requires) {
		const noun = gate.requires.nouns.some((n) => matchesKeyword(n, promptLower));
		const verb = gate.requires.verbs.some((v) => matchesKeyword(v, promptLower));
		if (noun && verb) return true;
	}
	return false;
}

// ── Extension entry ──────────────────────────────────────────────

/**
 * Fire any gates whose keywords or `requires` co-occurrence match `prompt`,
 * adding their tool names to `sticky`. This is the MUTATION half of the
 * per-turn pipeline; {@link filterActive} is the pure (compute) half.
 *
 * `sticky` is the accumulator of every tool activated so far THIS SESSION —
 * it starts as a copy of effectiveCore (the owner-declared always-active set)
 * and is mutated in place across turns, so a gate that fires once stays active
 * for the rest of the session (a workflow using flux2 must not lose the tool
 * mid-task just because a follow-up prompt like "make it bigger" doesn't repeat
 * the trigger keyword).
 */
export function updateSticky(prompt: string, sticky: Set<string>, gates: ToolGate[] = []): void {
	const promptLower = prompt.toLowerCase();
	for (const gate of gates) {
		if (gateFires(gate, promptLower)) {
			for (const name of gate.names) sticky.add(name);
		}
	}
}

/**
 * Find dormant gates that match `intent`. Pure: no pi dependency. Used by
 * enable_tool's intent mode. Returns gates in declaration order; empty = no
 * match.
 *
 * "Dormant" = not all of the gate's tools are already in `sticky`. A gate
 * matches when its `gateFires` predicate holds — i.e. a keyword match (single
 * ASCII tokens use word boundaries, phrases/CJK use substring) OR its optional
 * `requires` noun∧verb co-occurrence.
 *
 * NOTE: the `description` field is NOT a match surface — only keywords and
 * `requires`. Description-word matching was prototyped and rejected (prose
 * words like "image"/"pipeline" appear in several gates' descriptions and
 * over-match). `description` is still used for the human-readable `list` output
 * and a future semantic matcher. Verified 2026-07-20.
 */
export function matchIntent(
  intent: string,
  gates: ToolGate[],
  sticky: Set<string>,
): ToolGate[] {
  const needle = intent.toLowerCase();
  return gates.filter((g) => {
    if (g.names.every((n) => sticky.has(n))) return false; // skip already-active
    return gateFires(g, needle);
  });
}

// ── Telemetry (S3-lite, baked in) ─────────────────────────────────
// Opt-in: silent by default. Enable stderr output via TOOL_GATE_LOG=1, or
// write JSONL to a file via TOOL_GATE_LOG_PATH. Non-essential: write failures
// are swallowed. Purpose: quantify the dormant-tool miss rate (the
// "miss_candidate" kind) so the escape-hatch risk becomes measurable instead
// of structural-but-invisible. F4 (2026-07-20): flipped from opt-out to opt-in
// so production sessions stay quiet unless the developer explicitly enables it.

export interface ToolGateLogEntry {
  kind: "turn" | "activate" | "miss_candidate";
  ts: string;
  [k: string]: unknown;
}

export function emitToolGateLog(entry: ToolGateLogEntry): void {
  const file = process.env.TOOL_GATE_LOG_PATH;
  if (process.env.TOOL_GATE_LOG !== "1" && !file) return; // opt-in (F4)
  const line = JSON.stringify(entry);
  try {
    if (file) appendFileSync(file, line + "\n");
    else process.stderr.write(line + "\n");
  } catch {
    /* non-essential */
  }
}

/** A turn is a miss-candidate iff prompt non-empty, no gate fired, ≥1 dormant gate. */
export function isMissCandidate(
  prompt: string,
  gatesFired: string[],
  dormantGates: string[],
): boolean {
  return prompt.trim().length > 0 && gatesFired.length === 0 && dormantGates.length > 0;
}

/**
 * Sum the measured schema-token cost of gates that are (a) actually loaded
 * this session (at least one name in `allToolNames`) and (b) currently gated
 * (no name in `active`). `measuredTokens` is built once at session_start from
 * measureToolTokens — never drifts, measures the tools actually present.
 */
export function computeBannerSaved(
  active: string[],
  allToolNames: string[],
  measuredTokens: Map<string, number>,
  gates: ToolGate[] = [],
): number {
  const activeSet = new Set(active);
  return gates
    .filter((g) =>
      g.names.some((n) => allToolNames.includes(n)) && // loaded
      !g.names.some((n) => activeSet.has(n)))            // gated
    .reduce(
      (sum, g) => sum + g.names.reduce((s, n) => s + (measuredTokens.get(n) ?? 0), 0),
      0,
    );
}

/**
 * Token-cost estimate for a tool's schema. Delegates to power-tool's canonical
 * estimateToolCost (src/schema-cost) — the former inlined duplicate is gone, so
 * the schema-cost-agreement pinning test is obsolete. Kept as a thin wrapper so
 * existing call sites (session_start / before_agent_start / computeBannerSaved)
 * and tests keep their import + numeric return contract. `parameters` defaults
 * to `{}` (matching the prior inline heuristic, which measured undefined params
 * as JSON.stringify({})==2) so the unit test `measureToolTokens({})==1` holds;
 * `estimateToolCost` itself would otherwise count undefined params as 0.
 */
export function measureToolTokens(tool: { description?: string; parameters?: unknown }): number {
  return estimateToolCost(
    { description: tool.description, parameters: tool.parameters ?? {} },
    "(tool-gate)",
  ).approxTokens;
}

export default function toolGateExtension(pi: ExtensionAPI) {
  // A/B kill-switch (wayfinder ticket 04): TOOL_GATE_DISABLE=1 makes the
  // extension a no-op — registers nothing, sets no active tools — so every
  // loaded tool stays active (the ungated OFF baseline). Used by `bun run qa
  // --l2` to run identical tasks ON vs OFF. Cheap to respect early: the whole
  // gate (effectiveCore/sticky) is bypassed.
  if (process.env.TOOL_GATE_DISABLE === "1") return;
  // Disable-env contract (portable base set, test:isolation HONORS DISABLE ENV):
  // BUN_PI_TOOL_GATE=0 registers nothing — same convention as task/devops
  // (BUN_PI_TASK=0 / BUN_PI_DEVOPS=0).
  if (process.env.BUN_PI_TOOL_GATE === "0") return;

  type DiscoveredTool = { name: string; description?: string; parameters?: unknown; gating?: Gating };

  // Tool discovery goes through the shared bridge (pi 0.84.2's fixed-shape
  // ExtensionAPI hides runtime methods like getAllToolDefinitions from the
  // `pi` object extensions hold, so the direct read returned [] and — because
  // this extension loads LAST in the deploy order (registry order 190) — its
  // setActiveTools(filterActive([])) wiped EVERY tool from the deployed
  // session's API requests; repo runs were masked only by subagent/ultracode's
  // before_agent_start force-activators running after this gate. Found by the
  // live tmux deploy verification 2026-08-24: deployed request tools(0) vs
  // repo tools(15). readAllToolDefinitions is the blessed reader
  // (subagent/ultracode/knowledge-card use the same seam).
  //
  // "Bridge empty" is NOT "no tools exist" (the interface contract): when
  // NEITHER reader surface exists (patch disabled, pre-bindCore, non-pi host)
  // discovery returns null and every caller SKIPS gating — never zeroes the
  // active set on an unreadable toolset.
  const toolBridgeUp = (): boolean =>
    typeof (pi as typeof pi & { getAllToolDefinitions?: unknown }).getAllToolDefinitions === "function" ||
    typeof (globalThis as unknown as Record<string, unknown>)[ALL_TOOL_DEFINITIONS_GLOBAL] === "function";

  const getDiscovered = (): DiscoveredTool[] | null => {
    if (!toolBridgeUp()) return null;
    const raw = readAllToolDefinitions(pi) ?? [];
    // Ticket 03 (Path B): inject `gating:{ core: true }` onto the 4
    // pi-coding-agent built-ins (BUILTIN_CORE) so buildEffectiveGates routes
    // them into effectiveCore as owner-declared core. pi-coding-agent is
    // immutable + `gating` is extension-only, so this injection is the in-repo
    // equivalent of true owner-declaration (deferred to FOLLOWUPS #5).
    // Shallow-clones per def — see injectBuiltinCore; the runtime end-state is
    // unchanged (always-active).
    //
    // #1946 FOLLOW-UP (2026-08-24, caught by deploy-e2e's tools-probe): the
    // bridge source (getAllRegisteredTools) contains ONLY extension-registered
    // tools — the session's host built-ins (read/write/edit/bash/grep/find/ls)
    // live in _toolDefinitions and are INVISIBLE to it, so injectBuiltinCore
    // had nothing to inject onto. setActiveToolsByName then REPLACED
    // agent.state.tools with the ext-only list and the half-fixed deploys
    // (0.5.2+gf816e06) shipped sessions whose model had NO file tools while
    // ext-load, the gate seam and even the model-call probe stayed green.
    // Union the host built-ins in from pi.getAllTools() (the one registry that
    // carries them; ToolInfo name-only is all buildEffectiveGates needs) and
    // declare them core — the gate manages EXTENSION tools; host built-ins are
    // always-active by construction, exactly as they were before the gate.
    const discovered = injectBuiltinCore(raw);
    if (typeof pi.getAllTools !== "function") return discovered;
    const seen = new Set(discovered.map((t) => t.name));
    // sourceInfo.source === "builtin" (measured 2026-08-24 against pi 0.84.2:
    // `{"path":"<builtin:read>","source":"builtin"}`) is the discriminator —
    // name-matching would miss the NEXT builtin pi ships.
    const hostBuiltins = (
      pi.getAllTools() as Array<{ name: string; sourceInfo?: { source?: string } }>
    ).filter((t) => typeof t?.name === "string" && !seen.has(t.name) && t.sourceInfo?.source === "builtin");
    if (hostBuiltins.length === 0) return discovered;
    return [
      ...discovered,
      ...hostBuiltins.map((t) => ({ name: t.name, gating: { core: true } as Gating })),
    ];
  };

  // ── Per-session gate state (ticket 05) ─────────────────────────────────────
  // One state object PER SESSION, keyed by `ctx.sessionManager.getSessionId()`.
  // The full rebuild (getDiscovered + buildEffectiveGates + measureToolTokens)
  // runs ONCE at session_start; the per-turn path only fires + filters. This
  // kills two things: (F6) the per-turn full rebuild in before_agent_start, and
  // (F7) the `sticky.size === 0` sentinel hack for in-process subagent children.
  //
  // A child spawned via WorkflowAgent.run never fires session_start — its first
  // before_agent_start finds NO state for its session id and seeds one from
  // scratch (idempotent; touches only this map, never the parent's state).
  interface SessionGateState {
    allToolNames: string[];
    gates: ToolGate[];
    core: Set<string>;
    tracked: Set<string>;
    sticky: Set<string>;
    measuredTokens: Map<string, number>;
  }
  const gateStateBySession = new Map<string, SessionGateState>();
  /** Session id from ctx (ticket 05) — fallback "__default__" for hosts/tests
   *  without a sessionManager (the seam stays closed for them too). Null-safe:
   *  tool execute() call sites may pass no ctx at all. */
  const sessionIdOf = (ctx: unknown): string =>
    (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined | null)
      ?.sessionManager?.getSessionId?.() ?? "__default__";
  /** The one-time full build: capture tool list, gates, sticky (core), tokens. */
  const buildSessionState = (): SessionGateState | null => {
    const all = getDiscovered();
    if (all === null) return null;
    const eff = buildEffectiveGates(all);
    return {
      allToolNames: all.map((t) => t.name),
      gates: eff.gates,
      core: eff.core,
      tracked: eff.tracked,
      sticky: new Set(eff.core),
      measuredTokens: new Map(all.map((t) => [t.name, measureToolTokens(t)])),
    };
  };

  // ── Live-state seam (wayfinder ticket 06) ─────────────────────────────────
  // publishSeam("__piToolGateStatus") exposes a reader power-tool's
  // inspect_context calls to render the "tool gate" section: per-gate
  // fired/dormant + keywords + measured token cost, plus the sticky set.
  // `lastSessionId` tracks the most recent session (inspect_context carries no
  // session id, so the reader returns the current/last session's state).
  let lastSessionId = "__default__";
  publishSeam("__piToolGateStatus", (): ToolGateStatus | undefined => {
    const state = gateStateBySession.get(lastSessionId);
    if (!state) return undefined;
    const active = filterActive(state.allToolNames, state.sticky, state.tracked);
    return {
      sessionId: lastSessionId,
      activeCount: active.length,
      totalCount: state.allToolNames.length,
      coreCount: state.core.size,
      gates: state.gates.map((g) => ({
        id: g.gateId ?? g.names[0]!,
        names: g.names,
        fired: g.names.every((n) => state.sticky.has(n)),
        dormant: !g.names.every((n) => state.sticky.has(n)),
        keywords: g.keywords,
        tokens: g.names.reduce((s, n) => s + (state.measuredTokens.get(n) ?? 0), 0),
      })),
      sticky: [...state.sticky],
    };
  });

  // ── On session start: capture full tool list and gate (the ONE rebuild) ──
  pi.on("session_start", async (_event, ctx) => {
    const state = buildSessionState();
    lastSessionId = sessionIdOf(ctx);
    // Bridge down: the toolset is unreadable, not empty — leave the active set
    // untouched rather than gating on nothing (the pre-2026-08-24 wipe bug).
    if (state === null) return;
    gateStateBySession.set(lastSessionId, state);

    const active = filterActive(state.allToolNames, state.sticky, state.tracked);
    pi.setActiveTools(active);

    const saved = computeBannerSaved(active, state.allToolNames, state.measuredTokens, state.gates);
    const debug = process.env.TOOL_GATE_DEBUG_BANNER === "1";
    const theme = ctx.ui?.theme ?? ({ fg: (_k: string, s: string) => s } as NonNullable<typeof ctx.ui.theme>);
    scheduleToolGateBanner(
      ctx,
      [
        theme.fg("accent", `🔧 Tool gate: ${active.length}/${state.allToolNames.length} active`),
        theme.fg("dim", `saves ~${saved} tok/req`),
      ],
      debug ? { immediate: true, log: true } : undefined,
    );
  });

  // ── Per-turn: fire gates (sticky), filter, setActiveTools — NO rebuild ──
  // The full def/measure rebuild happens ONLY at session_start (buildSessionState).
  // A session with no state yet (in-process subagent child that skipped
  // session_start) seeds it here ONCE by session id — the F7 sentinel hack
  // (sticky.size === 0) is gone: state identity is the session id, not a size
  // heuristic, and this touches ONLY this map (never fires session_start in the
  // child, which would wipe the parent's core-task singletons).
  pi.on("before_agent_start", async (event, ctx) => {
    const sid = sessionIdOf(ctx);
    let state: SessionGateState | null | undefined = gateStateBySession.get(sid);
    if (!state) {
      state = buildSessionState();
      // Bridge down: skip this turn's gating entirely (see session_start).
      if (state === null) return;
      gateStateBySession.set(sid, state);
    }
    lastSessionId = sid;
    const prompt = event.prompt ?? "";

    const before = new Set(state.sticky);
    updateSticky(prompt, state.sticky, state.gates);
    const active = filterActive(state.allToolNames, state.sticky, state.tracked);
    pi.setActiveTools(active);

    // telemetry: which gates newly fired this turn, which are still dormant
    const gatesFired = state.gates
      .filter((g) => g.names.some((n) => state.sticky.has(n) && !before.has(n)))
      .map((g) => g.names[0]);
    const dormantGates = state.gates
      .filter((g) => !g.names.every((n) => state.sticky.has(n)))
      .map((g) => g.names[0]);

    emitToolGateLog({
      kind: "turn", ts: new Date().toISOString(),
      promptLen: prompt.length, gatesFired, dormantGates,
      activeCount: active.length, totalCount: state.allToolNames.length,
      savedTok: computeBannerSaved(active, state.allToolNames, state.measuredTokens, state.gates),
    });
    if (isMissCandidate(prompt, gatesFired, dormantGates)) {
      emitToolGateLog({
        kind: "miss_candidate", ts: new Date().toISOString(),
        dormantGates, promptHead: prompt.slice(0, 80),
      });
    }
  });

  // Session teardown (ticket 05): drop the session's gate state so a fresh
  // session never inherits a prior session's sticky/gates, and the map never
  // grows unbounded across many sessions.
  pi.on("session_shutdown", async (_event, ctx) => {
    gateStateBySession.delete(sessionIdOf(ctx));
  });

  // ── Escape hatch: enable_tool (always active; activates dormant gates) ──
  // F8 (ticket 01, phase 01c): the description is DERIVED from the GATE_DEFS
  // registry — no hardcoded domain prose that drifts from the actual gates.
  const enableToolDescription =
    `Heavy tools are GATED out of your tool list to save context. Registered gate ` +
    `families: ${Object.keys(GATE_DEFS).sort().join(", ") || "(none loaded yet)"}. ` +
    `If you need a capability you don't see, call this tool: use \`intent\` to describe what ` +
    `you want (e.g. 'make a video', 'generate an image', 'orchestrate a montage'), \`name\` to ` +
    `activate a specific tool or family (e.g. 'ltx', 'flux2', 'movie', 'workflow'), or ` +
    `\`list:true\` to see dormant tools. Activation is sticky — once enabled, the tool stays ` +
    `available for the session.`;
  pi.registerTool({
    name: "enable_tool",
    gating: { core: true },
    label: "Enable a gated tool",
    description: enableToolDescription,
    promptSnippet: "Enable a gated heavy tool (video/image/movie/...) by intent or name.",
    promptGuidelines: [
      "If you need a capability not in your tool list (e.g. video/image/movie generation), call enable_tool first rather than telling the user it's unavailable.",
    ],
    parameters: Type.Object({
      intent: Type.Optional(Type.String({ description: "Natural-language description of what you want to do; the matching gated tool is activated." })),
      name: Type.Optional(Type.String({ description: "Exact tool or gate name to activate (e.g. 'ltx', 'flux2', 'movie')." })),
      list: Type.Optional(Type.Boolean({ description: "If true, return the list of currently dormant gated tools." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        // Resolve the CALLING session's gate state (ticket 05) — a tool execute
        // runs inside a session; if that session has no state yet (defensive —
        // session_start or the child seed always runs first), seed on demand.
        const sid = sessionIdOf(_ctx);
        const existing = gateStateBySession.get(sid);
        let seeded: SessionGateState | undefined;
        if (!existing) {
          const built = buildSessionState();
          if (built === null) {
            return {
              details: undefined,
              content: [{
                type: "text" as const,
                text: "Tool gate: tool discovery is unavailable in this host (bridge down) — no gates to enable.",
              }],
            };
          }
          gateStateBySession.set(sid, built);
          seeded = built;
        }
        const state = existing ?? seeded!;
        if (params.list) {
          const dormant = state.gates.filter((g) => !g.names.every((n) => state.sticky.has(n)));
          const lines = dormant.map(
            (g) => `- ${g.names.join(", ")} — ${g.description} (keywords: ${g.keywords.slice(0, 6).join(", ")})`,
          );
          return {
            details: undefined,
            content: [{
              type: "text" as const,
              text: dormant.length
                ? `Dormant gated tools:\n${lines.join("\n")}`
                : "No dormant tools — all gates are active.",
            }],
          };
        }

        let matched: ToolGate[] = [];
        let via: "name" | "intent" = "intent";
        if (params.name) {
          via = "name";
          const gate = state.gates.find((g) => g.names.includes(params.name as string));
          if (!gate) {
            matched = [];
          } else {
            // Sibling co-activation by construction (wayfinder ticket 01): since
            // phase 01c, buildEffectiveGates groups every tool referencing the
            // same gate id into ONE multi-name family gate (e.g. workflow /
            // workflow_help / workflow_control / subagent / subagents all live in
            // the "workflow" gate). A name lookup therefore already returns the
            // WHOLE family — no fingerprint reconstruction needed (gateGatingKey /
            // gatesWithSameGating were deleted in 01c). Mirror matchIntent's
            // already-active filtering: keep the gate only while it still has a
            // dormant (not-yet-sticky) name, so the reported `activated` list
            // contains only newly-on tools.
            const dormant = !gate.names.every((n) => state.sticky.has(n)) ? [gate] : [];
            if (dormant.length === 0) {
              // F3: the matched family gate is already fully active.
              emitToolGateLog({
                kind: "activate", ts: new Date().toISOString(),
                via, intent: params.name as string, matchedGate: null, activated: [],
              });
              return {
                details: undefined,
                content: [{ type: "text" as const, text: `'${params.name}' is already active.` }],
              };
            }
            matched = dormant;
          }
        } else if (params.intent) {
          matched = matchIntent(params.intent, state.gates, state.sticky);
        } else {
          return {
            details: undefined,
            content: [{
              type: "text" as const,
              text: "Call enable_tool with exactly one of: intent, name, or list:true.",
            }],
          };
        }

        const askedFor = (params.name ?? params.intent) as string;
        if (matched.length === 0) {
          emitToolGateLog({
            kind: "activate", ts: new Date().toISOString(),
            via, intent: askedFor, matchedGate: null, activated: [],
          });
          return {
            details: undefined,
            content: [{
              type: "text" as const,
              text: `No dormant tool matched '${askedFor}'. Call enable_tool with list:true to see available tools.`,
            }],
          };
        }

        const activated: string[] = [];
        for (const g of matched) for (const n of g.names) { state.sticky.add(n); activated.push(n); }
        // F1 fix: compute the active list directly from sticky — do NOT
        // re-evaluate gates against the turn prompt (updateSticky), which
        // would silently activate additional gates beyond the one explicitly
        // requested. Pass the session's tracked set so owner-declared gated
        // tools are NOT treated as fail-open — without this they'd be
        // spuriously active on recompute.
        const active = filterActive(state.allToolNames, state.sticky, state.tracked);
        pi.setActiveTools(active);
        emitToolGateLog({
          kind: "activate", ts: new Date().toISOString(),
          via, intent: askedFor, matchedGate: matched.map((g) => g.names[0]), activated,
        });
        return {
          details: undefined,
          content: [{
            type: "text" as const,
            text: `✓ Activated: ${activated.join(", ")}. You can call them directly.`,
          }],
        };
      } catch (err) {
        return {
          details: undefined,
          content: [{
            type: "text" as const,
            text: `enable_tool error: ${(err as Error).message ?? String(err)}`,
          }],
        };
      }
    },
  });
}
