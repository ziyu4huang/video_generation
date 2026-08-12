/// <reference types="@repo/pi-agent-ext-core-interface" />
/**
 * Dynamic Tool Gate Extension — reduces API tools schema overhead
 *
 * Keeps core tools always active while gating heavy domain-specific tools
 * behind prompt keyword matching. Every gate is owner-declared via `gating` on
 * the owning tool's def (tickets 03–12 migrated flux2/ltx/krea2/movie/
 * research-tool/workflow/subagent/inspect/zai-mcp off the former hardcoded
 * GATES array; ticket 15 deleted that now-empty array — no legacy fallback).
 * (pi_deploy/pi_verify migrated to owner-declared gating in ticket 03;
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
 * Baseline:  ~55 tools → ~18,000 tok/req   (measured via `bun run qa`)
 * Gated:    ON at start ~10,000 tok/req   (saves ~9,800 tok/turn, ~52%; net ~9,600; zai-mcp env-gated)
 *
 * Tools reactivate instantly when the prompt mentions relevant keywords, and
 * once activated stay active for the rest of the session (they never re-gate
 * on a later turn).
 *
 * Install: registered in bun-apps/pi-agent/run-dir/manifest.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import { estimateToolCost } from "@repo/pi-agent-ext-power-tool/schema-cost";

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
  gates: ToolGate[];   // non-core gates: one per owner-declared non-core tool (single-name)
  core: Set<string>;   // always-active names: owner-declared core:true
  tracked: Set<string>; // core ∪ all gate names — the explicit-track set for filterActive
}

/**
 * Build the effective gate set for a session from owner-declared `gating`:
 * authoritative, NO hardcoded fallback (ticket 04 deleted the former CORE_TOOLS
 * always-active set — every core member is now owner-declared via tickets 02 +
 * 03; ticket 15 earlier deleted the hardcoded GATES array). A `core:true` def →
 * always-active core; any other `gating` def → a single-name gate; a def without
 * `gating` is simply ungated. Pure: no pi dependency.
 */
export function buildEffectiveGates(
  defs: Array<{ name: string; description?: string; gating?: Gating }>,
): EffectiveGates {
  const gates: ToolGate[] = [];
  const core = new Set<string>();
  for (const def of defs) {
    const g = def.gating;
    if (!g) continue;
    if (g.core === true) {
      core.add(def.name);
    } else {
      gates.push({
        names: [def.name],
        keywords: g.keywords ?? [],
        requires: g.requires,
        description: def.description ?? "",
      });
    }
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
 * after a short delay, then auto-dismiss. Mirrors pi-agent-ext-obsidian's
 * scheduleVaultBanner() and pi-agent-ext-zai-mcp's scheduleReadyBanner()
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

/**
 * Structural fingerprint of a gate's owner-declared gating — its `keywords` and
 * optional `requires` (noun∧verb) co-occurrence spec. Two gates with the same
 * fingerprint share identical gating and therefore co-fire together under
 * {@link matchIntent} / {@link updateSticky}: when one fires on a prompt, every
 * sibling fires. `description` is intentionally excluded (it is not a match
 * surface — see {@link matchIntent}). Pure + deterministic regardless of
 * declaration order (keywords/nouns/verbs are sorted). Used by enable_tool NAME
 * mode to co-activate siblings, so the escape hatch behaves consistently whether
 * a tool is requested by name or by intent.
 */
export function gateGatingKey(gate: ToolGate): string {
  return JSON.stringify({
    keywords: [...gate.keywords].sort(),
    requires: gate.requires
      ? {
          nouns: [...(gate.requires.nouns ?? [])].sort(),
          verbs: [...(gate.requires.verbs ?? [])].sort(),
        }
      : null,
  });
}

/**
 * Every gate in `all` whose owner-declared gating is identical to `gate`'s — the
 * sibling group that co-fires together (always includes `gate` itself). Pure.
 * Used by enable_tool NAME mode so requesting one member of a gated family (e.g.
 * `workflow`) also activates its siblings (e.g. `workflow_help`,
 * `workflow_control`, `subagent`, `subagents`) — matching the co-firing that
 * already happens under intent mode and auto-gating.
 */
export function gatesWithSameGating(gate: ToolGate, all: ToolGate[]): ToolGate[] {
  const key = gateGatingKey(gate);
  return all.filter((g) => gateGatingKey(g) === key);
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

  type DiscoveredTool = { name: string; description?: string; parameters?: unknown; gating?: Gating };
  const getDiscovered = (): DiscoveredTool[] => {
    const fn = (pi as typeof pi & { getAllToolDefinitions?(): DiscoveredTool[] }).getAllToolDefinitions;
    const raw = typeof fn === "function" ? fn() : [];
    // Ticket 03 (Path B): inject `gating:{ core: true }` onto the 4
    // pi-coding-agent built-ins (BUILTIN_CORE) so buildEffectiveGates routes
    // them into effectiveCore as owner-declared core. pi-coding-agent is
    // immutable + `gating` is extension-only, so this injection is the in-repo
    // equivalent of true owner-declaration (deferred to FOLLOWUPS #5).
    // Shallow-clones per def — see injectBuiltinCore; the runtime end-state is
    // unchanged (always-active).
    return injectBuiltinCore(raw);
  };
  let effectiveGates: ToolGate[] = [];
  let effectiveCore: Set<string> = new Set<string>();
  let effectiveTracked: Set<string> = new Set<string>();

  let allToolNames: string[] = [];
  let sticky = new Set<string>();
  let measuredTokens = new Map<string, number>(); // built at session_start (S3), grown per-turn (M7)

  // ── On session start: capture full tool list and gate ──
  pi.on("session_start", async (_event, ctx) => {
    const all = getDiscovered();
    allToolNames = all.map((t) => t.name);
    const eff = buildEffectiveGates(all);
    effectiveGates = eff.gates; effectiveCore = eff.core; effectiveTracked = eff.tracked;
    sticky = new Set(effectiveCore);

    measuredTokens = new Map(all.map((t) => [t.name, measureToolTokens(t)]));

    const active = filterActive(allToolNames, sticky, effectiveTracked);
    pi.setActiveTools(active);

    const saved = computeBannerSaved(active, allToolNames, measuredTokens, effectiveGates);
    const debug = process.env.TOOL_GATE_DEBUG_BANNER === "1";
    const theme = ctx.ui?.theme ?? ({ fg: (_k: string, s: string) => s } as NonNullable<typeof ctx.ui.theme>);
    scheduleToolGateBanner(
      ctx,
      [
        theme.fg("accent", `🔧 Tool gate: ${active.length}/${allToolNames.length} active`),
        theme.fg("dim", `saves ~${saved} tok/req`),
      ],
      debug ? { immediate: true, log: true } : undefined,
    );
  });

  // ── Per-turn: refresh tool list (D), re-evaluate gates (sticky), emit telemetry ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const all = getDiscovered();
    allToolNames = all.map((t) => t.name);
    const eff = buildEffectiveGates(all);
    effectiveGates = eff.gates; effectiveCore = eff.core; effectiveTracked = eff.tracked;
    // #2 — in-process subagent children (WorkflowAgent.run → createAgentSession) skip
    // session_start (bindExtensions is never called for them), so `sticky` starts and
    // stays empty: core tools land in effectiveTracked but never in sticky → they get
    // filtered out, and measuredTokens is built lazily every turn instead of once.
    // Seed idempotently here. This touches ONLY tool-gate's own closure state — do NOT
    // instead fire session_start in the child, which would wipe the parent's core-task
    // singletons (shared module cells). See .planning/2026-08-08-fix-subagent-spawn-seam-
    // tool-gate-core-task/ ticket 02 + map.md KEY CONSTRAINT.
    if (sticky.size === 0) {
      sticky = new Set(effectiveCore);
      measuredTokens = new Map(all.map((t) => [t.name, measureToolTokens(t)]));
    }
    for (const t of all) {
      if (!measuredTokens.has(t.name)) measuredTokens.set(t.name, measureToolTokens(t));
    }
    const prompt = event.prompt ?? "";

    const before = new Set(sticky);
    updateSticky(prompt, sticky, effectiveGates);
    const active = filterActive(allToolNames, sticky, effectiveTracked);
    pi.setActiveTools(active);

    // telemetry: which gates newly fired this turn, which are still dormant
    const gatesFired = effectiveGates
      .filter((g) => g.names.some((n) => sticky.has(n) && !before.has(n)))
      .map((g) => g.names[0]);
    const dormantGates = effectiveGates
      .filter((g) => !g.names.every((n) => sticky.has(n)))
      .map((g) => g.names[0]);

    emitToolGateLog({
      kind: "turn", ts: new Date().toISOString(),
      promptLen: prompt.length, gatesFired, dormantGates,
      activeCount: active.length, totalCount: allToolNames.length,
      savedTok: computeBannerSaved(active, allToolNames, measuredTokens, effectiveGates),
    });
    if (isMissCandidate(prompt, gatesFired, dormantGates)) {
      emitToolGateLog({
        kind: "miss_candidate", ts: new Date().toISOString(),
        dormantGates, promptHead: prompt.slice(0, 80),
      });
    }
  });

  // ── Escape hatch: enable_tool (always active; activates dormant gates) ──
  pi.registerTool({
    name: "enable_tool",
    gating: { core: true },
    label: "Enable a gated tool",
    description:
      "Heavy tools (flux2 image, ltx video, movie orchestrator, krea2, file2md/vision, inspect, workflow, research/video-collect, arxiv papers, movie-production cost, z.ai web tools, pi-agent deploy/verify) are GATED out of your tool list to save context. If you need a capability you don't see, call this tool: use `intent` to describe what you want (e.g. 'make a video', 'generate an image', 'orchestrate a montage'), `name` to activate a specific tool (e.g. 'ltx', 'flux2', 'movie'), or `list:true` to see dormant tools. Activation is sticky — once enabled, the tool stays available for the session.",
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
        if (params.list) {
          const dormant = effectiveGates.filter((g) => !g.names.every((n) => sticky.has(n)));
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
          const gate = effectiveGates.find((g) => g.names.includes(params.name as string));
          if (!gate) {
            matched = [];
          } else {
            // Sibling co-activation: buildEffectiveGates splits each owner-declared
            // tool into a single-name gate, so a name resolves to exactly one gate —
            // but tools that share identical owner-declared gating (e.g. workflow /
            // workflow_help / workflow_control / subagent / subagents) co-fire as a
            // family under intent mode (matchIntent) and auto-gating (updateSticky).
            // Extend that same behavior to NAME mode so the escape hatch is
            // consistent regardless of how a tool is requested. Sibling identity =
            // identical gating fingerprint (see gatesWithSameGating).
            const siblings = gatesWithSameGating(gate, effectiveGates);
            // Mirror matchIntent's already-active filtering: keep only gates that
            // still have at least one dormant (not-yet-sticky) name, so the reported
            // `activated` list contains only newly-on tools.
            const dormant = siblings.filter((g) => !g.names.every((n) => sticky.has(n)));
            if (dormant.length === 0) {
              // F3: the matched gate AND all its siblings are already fully active.
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
          matched = matchIntent(params.intent, effectiveGates, sticky);
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
        for (const g of matched) for (const n of g.names) { sticky.add(n); activated.push(n); }
        // F1 fix: compute the active list directly from sticky — do NOT
        // re-evaluate gates against the turn prompt (updateSticky), which
        // would silently activate additional gates beyond the one explicitly
        // requested. Pass effectiveTracked so owner-declared gated tools are
        // NOT treated as fail-open — without this they'd be spuriously active
        // on recompute.
        const active = filterActive(allToolNames, sticky, effectiveTracked);
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
