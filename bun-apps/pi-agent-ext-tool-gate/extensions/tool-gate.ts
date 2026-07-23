/**
 * Dynamic Tool Gate Extension — reduces API tools schema overhead
 *
 * Keeps core tools always active while gating heavy domain-specific tools
 * (flux2, ltx, krea2, file2md, inspect, workflow, movie, arxiv, cost,
 * zai-mcp, pi_deploy) behind prompt keyword matching.
 *
 * Baseline:  ~52 tools → ~16,500 tok/req   (measured via `bun run qa`)
 * Gated:    ~24 tools →  ~7,900 tok/req   (saves ~8,500 tok/turn, ~52%; zai-mcp env-gated)
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

// ── Tool categories ──────────────────────────────────────────────

/** Tools that must always be available (core workflow) */
export const CORE_TOOLS = new Set([
  // Built-in essentials
  "read", "write", "edit", "bash",
  // Task & goal
  "todo", "goal_complete",
  // Memory & session
  "memory", "memory_search", "session_search",
  // User interaction
  "ask_user_question",
  // Escape hatch for dormant gated tools (always active)
  "enable_tool",
  // Skills
  "skill_manage",
  "grill_decision", // hermes-memory — grilling is a frequent workflow
  // Vault & knowledge (used frequently)
  "obsidian", "obsidian_help",
  "zk_card", "zk_ask", "zk_ingest", "knowledge_query",
  // Web access
  "web_search", "fetch_content", "get_search_content",
]);

/** Co-occurrence trigger: a gate fires when the prompt has ≥1 noun AND ≥1 verb.
 *  Used only for core nouns (image/video/pdf) whose bare form false-fires
 *  (docker image, video call) but whose recall on common intents
 *  (generate an image, make a video) must survive. */
export interface CoOccurrence {
  nouns: string[];
  verbs: string[];
}

interface ToolGate {
  names: string[];
  /** Unambiguous triggers — matched via matchesKeyword. */
  keywords: string[];
  /** One-line description — used for enable_tool intent matching + list output. */
  description: string;
  /** Optional co-occurrence trigger (noun ∧ verb). See CoOccurrence. */
  requires?: CoOccurrence;
}

/**
 * Gated tool groups. A gate fires (via gateFires) if any keyword matches, OR
 * its optional `requires` co-occurrence (≥1 noun AND ≥1 verb) is met.
 *
 * S2 audit (2026-07-20): over-broad bare words removed (image/scene/style/swap/
 * render/draft/video/電影/動畫/describe/what is in/vision/pdf/chain/collect/
 * organize/movie/compose). Core nouns (image/video/pdf) moved behind `requires`
 * so they fire only alongside a generation/action verb — killing false-fires
 * (docker image, video call) while preserving recall (generate an image, make a
 * video). Keywords are matched case-insensitively; single ASCII tokens use word
 * boundaries, phrases/CJK use substring.
 */
export const GATES: ToolGate[] = [
  {
    names: ["flux2", "flux2_help"],
    keywords: [
      "flux", "flux2", "outpaint", "upscale image", "t2i", "txt2img",
      "圖像", "圖片", "生成圖", "產圖", "繪圖", "修圖", "去背", "換臉",
      "做成圖", "轉成圖",
    ],
    requires: {
      nouns: ["image", "picture", "photo", "圖"],
      verbs: ["generate", "create", "make", "draw", "render", "produce", "want", "need", "生成", "做", "畫", "繪"],
    },
    description: "Flux2 image generation — text-to-image, i2i, faceswap, outpaint, upscale, restore",
  },
  {
    // No `requires` co-occurrence: krea2's keywords ("krea", "草圖", "快速生成",
    // ...) are narrow enough that bare-word false-fires are unlikely, unlike
    // the core nouns (image/video/pdf) that need noun∧verb gating. A prompt
    // like "快速生成一個圖" fires flux2 (via requires) but not krea2 unless
    // "krea"/"草圖" literally appears — intentional precision tradeoff.
    names: ["krea2", "krea2_help"],
    keywords: ["krea", "krea2", "草圖", "快速生成", "即時生成", "實時繪圖", "sketch", "real-time", "real time"],
    description: "Krea2 fast image generation — real-time draft to image",
  },
  {
    names: ["ltx", "ltx_help"],
    keywords: ["ltx", "t2v", "i2v", "vbvr", "relay", "影片特效"],
    requires: {
      nouns: ["video", "影片", "視頻", "視訊", "動畫", "電影"],
      verbs: ["generate", "create", "make", "animate", "produce", "render", "want", "need", "生成", "做", "製作", "剪"],
    },
    description: "LTX video generation — text/image-to-video, upscale, vbvr, relay",
  },
  {
    names: ["file2md", "vision_ask"],
    keywords: [
      "file2md", "vlm", "ocr", "caption", "to markdown", "轉 markdown",
      "read this image", "分析圖片", "分析圖像", "識別", "讀圖", "看圖",
    ],
    requires: {
      nouns: ["pdf", "document", "文件", "scan", "image", "picture", "photo", "圖"],
      verbs: ["read", "convert", "parse", "extract", "ocr", "describe", "caption", "讀", "轉", "解析", "分析"],
    },
    description: "Document/image understanding — file→markdown, VLM describe, OCR, caption",
  },
  {
    names: ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology", "inspect_tui"],
    keywords: [
      "schema cost", "pathology", "extension health",
      "工具開銷", "context window", "token usage",
    ],
    requires: {
      nouns: ["agent", "context", "extension", "pathology", "token", "schema", "tui", "工具"],
      verbs: ["inspect", "show", "check", "diagnose", "dump", "report"],
    },
    description: "Agent/extension introspection — context tokens, extension health, pathology",
  },
  {
    names: ["workflow", "workflow_help", "subagent", "workflow_control"],
    keywords: [
      "workflow", "pipeline", "orchestrate", "fan-out", "fan out", "parallel agent",
      "multi-step",
    ],
    description: "Workflow orchestrator — multi-agent fan-out/pipeline JavaScript scripts",
  },
  {
    names: ["collect_videos", "organize_vault_notes", "import_memory_to_vault"],
    keywords: [
      "bilibili", "youtube", "collect videos", "video trending",
      "vault notes", "organize vault", "import memory",
      "收集影片", "整理筆記",
    ],
    description: "Research tools — collect trending videos, organize vault notes, import memory",
  },
  {
    // ArXiv paper retrieval (research-tool ext). "arxiv" is a narrow
    // word-boundary keyword (near-zero false-fire); CJK 論文 + the noun∧verb
    // `requires` cover "search/find/read papers" intents WITHOUT firing on
    // bare "paper" alone (paper cut, a paper trail). arxiv_paper (93 tok) is
    // included for free — one more gated name costs nothing and removes a
    // light always-on tool. Recovered ~566 tok/req (wayfinder ticket 04).
    names: ["arxiv_search", "arxiv_fetch2md", "arxiv_paper"],
    keywords: ["arxiv", "論文", "找論文", "抓論文", "讀論文", "search paper", "search papers", "find paper", "find papers"],
    requires: {
      nouns: ["paper", "papers", "論文"],
      verbs: ["search", "find", "fetch", "read", "look up", "找", "查", "搜尋", "讀"],
    },
    description: "ArXiv paper retrieval — search, fetch-to-markdown, metadata lookup",
  },
  {
    names: ["movie", "movie_help"],
    keywords: [
      "montage", "preflight", "storyboard", "分鏡", "剪輯",
      "影片製作", "導演", "make a movie", "make a film", "movie director",
      "compose video", "compose scene", "電影製作",
      "short film", "into a film", "scenes into",
    ],
    description: "Movie orchestrator — idea→script→scene→assets→edit→compose pipeline",
  },
  {
    // Movie-production cost lifecycle (movie-director-cost ext). Bare "cost"
    // must NOT be a keyword — it false-fires everywhere ("token cost", "cost
    // of living", "what's the cost"). Gate behind noun∧verb `requires`
    // (cost/budget/成本/預算 ∧ estimate/calculate/...) so only cost-ESTIMATION
    // intent fires. Benign false-fires ("estimate the token cost") load the
    // tool unused — non-gating per the QA verdict; documented in
    // PRECISION_RISKS. Recovered ~538 tok/req (wayfinder ticket 04).
    names: ["cost"],
    keywords: ["cost estimate", "cost lifecycle", "budget estimate", "production cost", "成本估算", "預算估計", "報價單", "cost reserve", "cost reconcile", "cost snapshot"],
    requires: {
      nouns: ["cost", "budget", "報價", "成本", "預算", "quote"],
      verbs: ["estimate", "reserve", "reconcile", "calculate", "breakdown", "snapshot", "估算", "計算", "評估", "估"],
    },
    description: "Movie-production cost lifecycle — estimate/reserve/reconcile/snapshot budget governance",
  },
  {
    // zai-mcp MCP proxy tools — redundant with core web_search/fetch_content
    // but have large schemas (~1.1k tok combined). Gate behind intent so they
    // only load when the agent explicitly needs Z.ai's search/reader endpoint.
    names: ["zai_web_search_web_search_prime", "zai_web_reader_webReader"],
    keywords: [
      "zai search", "zai reader", "zai web", "zai_mcp",
      "z.ai", "z.ai search", "z.ai reader",
    ],
    description: "Z.ai MCP web tools — web-search-prime + web-reader (redundant with core web tools)",
  },
  {
    // Bare "deploy"/"verify" are NOT keywords — they false-fire everywhere
    // ("deploy to vercel", "verify the fix"), violating the S2 bare-word rule
    // the cost/image/video gates follow. Gate behind noun∧verb `requires`
    // (bundle/pi-agent/extension noun ∧ build/deploy/verify/test verb) so only
    // pi-agent-bundling intent fires. The prior "verify the test results"
    // false-fire is now fixed (removed from PRECISION_RISKS).
    names: ["pi_deploy", "pi_verify"],
    keywords: ["build bundle", "bundle pi-agent", "pi-agent bundle", "run-test"],
    requires: {
      nouns: ["bundle", "pi-agent", "pi agent", "extension"],
      verbs: ["build", "deploy", "verify", "test", "bundle", "部署", "建置", "驗證", "打包"],
    },
    description: "Build/verify/deploy the pi-agent bundle + extension bundles (wraps deploy.ts + run-test.sh)",
  },
];

/** Union of CORE_TOOLS and every gate's tool names — the set of tools this
 *  extension explicitly tracks. Unknown tools (not in this set) are always
 *  active (fail-open). Precomputed at module load so callers that need the
 *  active list without re-firing gates can filter directly. */
const TRACKED_TOOLS = new Set([...CORE_TOOLS, ...GATES.flatMap((g) => g.names)]);

/** Pure: filter `allToolNames` to those that should be active given `sticky`.
 *  Tools not in TRACKED_TOOLS are always active (fail-open); tracked tools
 *  are active only when present in `sticky`. Does NOT mutate sticky or
 *  evaluate gate keywords — gate firing is a separate concern. */
export function filterActive(allToolNames: string[], sticky: Set<string>): string[] {
  return allToolNames.filter((name) => !TRACKED_TOOLS.has(name) || sticky.has(name));
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
// keyspace is the finite GATES keyword/noun/verb set (~120), so the cache is
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
 * it starts as a copy of CORE_TOOLS and is mutated in place across turns, so
 * a gate that fires once stays active for the rest of the session (a workflow
 * using flux2 must not lose the tool mid-task just because a follow-up prompt
 * like "make it bigger" doesn't repeat the trigger keyword).
 */
export function updateSticky(prompt: string, sticky: Set<string>): void {
	const promptLower = prompt.toLowerCase();
	for (const gate of GATES) {
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
): number {
  const activeSet = new Set(active);
  return GATES
    .filter((g) =>
      g.names.some((n) => allToolNames.includes(n)) && // loaded
      !g.names.some((n) => activeSet.has(n)))            // gated
    .reduce(
      (sum, g) => sum + g.names.reduce((s, n) => s + (measuredTokens.get(n) ?? 0), 0),
      0,
    );
}

/**
 * Estimate a single tool's API schema-cost in tokens. Replicates the
 * schema-cost CLI heuristic verbatim (`schema-cost.ts:20`):
 *   Math.round((description.length + JSON.stringify(parameters).length) / 4)
 * charsPerToken = 4 (no real tokenizer). Pure + dependency-free — inlined here
 * (not imported from pi-agent-ext-power-tool) to keep this always-on extension
 * decoupled. Missing description/parameters are treated as empty (0). The
 * JSON.stringify is guarded so a malformed schema never crashes session_start.
 */
export function measureToolTokens(tool: { description?: string; parameters?: unknown }): number {
  const desc = (tool.description ?? "").length;
  let params = 0;
  try {
    params = JSON.stringify(tool.parameters ?? {}).length;
  } catch {
    params = 0; // non-serializable schema — fail-safe, never crash
  }
  return Math.round((desc + params) / 4);
}

export default function toolGateExtension(pi: ExtensionAPI) {
  // A/B kill-switch (wayfinder ticket 04): TOOL_GATE_DISABLE=1 makes the
  // extension a no-op — registers nothing, sets no active tools — so every
  // loaded tool stays active (the ungated OFF baseline). Used by `bun run qa
  // --l2` to run identical tasks ON vs OFF. Cheap to respect early: the whole
  // gate (CORE_TOOLS/GATES/sticky) is bypassed.
  if (process.env.TOOL_GATE_DISABLE === "1") return;

  let allToolNames: string[] = [];
  let sticky = new Set<string>(CORE_TOOLS);
  let measuredTokens = new Map<string, number>(); // built at session_start (S3), grown per-turn (M7)

  // ── On session start: capture full tool list and gate ──
  pi.on("session_start", async (_event, ctx) => {
    const all = pi.getAllTools();
    allToolNames = all.map((t: { name: string }) => t.name);
    sticky = new Set(CORE_TOOLS);

    // S3: measure each loaded tool's schema cost once for the session.
    measuredTokens = new Map(
      all.map((t: { name: string; description?: string; parameters?: unknown }) =>
        [t.name, measureToolTokens(t)]),
    );

    // session_start prompt is "" → updateSticky is a no-op; just filter.
    const active = filterActive(allToolNames, sticky);
    pi.setActiveTools(active);

    // G fix + S3: only count loaded gates, using measured (not stale) token costs.
    const saved = computeBannerSaved(active, allToolNames, measuredTokens);

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
    // D: re-fetch each turn so dynamically-registered or renamed tools are seen.
    const all = pi.getAllTools();
    allToolNames = all.map((t: { name: string }) => t.name);
    // M7: measure any tool that appeared since session_start (lazily-registered
    // extensions) so savedTok/banner reflect the tools actually present this
    // turn instead of under-counting late arrivals as 0 tokens.
    for (const t of all as Array<{ name: string; description?: string; parameters?: unknown }>) {
      if (!measuredTokens.has(t.name)) measuredTokens.set(t.name, measureToolTokens(t));
    }
    const prompt = event.prompt ?? "";

    const before = new Set(sticky);
    updateSticky(prompt, sticky);
    const active = filterActive(allToolNames, sticky);
    pi.setActiveTools(active);

    // telemetry: which gates newly fired this turn, which are still dormant
    const gatesFired = GATES
      .filter((g) => g.names.some((n) => sticky.has(n) && !before.has(n)))
      .map((g) => g.names[0]);
    const dormantGates = GATES
      .filter((g) => !g.names.every((n) => sticky.has(n)))
      .map((g) => g.names[0]);

    emitToolGateLog({
      kind: "turn", ts: new Date().toISOString(),
      promptLen: prompt.length, gatesFired, dormantGates,
      activeCount: active.length, totalCount: allToolNames.length,
      savedTok: computeBannerSaved(active, allToolNames, measuredTokens),
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
          const dormant = GATES.filter((g) => !g.names.every((n) => sticky.has(n)));
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
          const gate = GATES.find((g) => g.names.includes(params.name as string));
          // F3: if the gate exists but is already fully active, say so instead
          // of misleadingly reporting "Activated".
          if (gate && gate.names.every((n) => sticky.has(n))) {
            emitToolGateLog({
              kind: "activate", ts: new Date().toISOString(),
              via, intent: params.name as string, matchedGate: null, activated: [],
            });
            return {
              details: undefined,
              content: [{ type: "text" as const, text: `'${params.name}' is already active.` }],
            };
          }
          matched = gate ? [gate] : [];
        } else if (params.intent) {
          matched = matchIntent(params.intent, GATES, sticky);
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
        // requested.
        const active = filterActive(allToolNames, sticky);
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
