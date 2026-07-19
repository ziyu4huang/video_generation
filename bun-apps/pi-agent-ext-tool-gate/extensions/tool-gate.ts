/**
 * Dynamic Tool Gate Extension — reduces API tools schema overhead
 *
 * Keeps core tools always active while gating heavy domain-specific tools
 * (flux2, ltx, krea2, file2md, inspect, workflow, research) behind prompt
 * keyword matching.
 *
 * Baseline:  41 tools → ~18,500 tok/req
 * Gated:    ~27 tools → ~10,000 tok/req  (saves ~8,500 tok per turn)
 *
 * Tools reactivate instantly when the prompt mentions relevant keywords, and
 * once activated stay active for the rest of the session (they never re-gate
 * on a later turn).
 *
 * Install: registered in bun-apps/pi-agent/run-dir/manifest.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

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
  // Skills
  "skill_manage",
  // Vault & knowledge (used frequently)
  "obsidian",
  "zk_card", "zk_ask", "zk_ingest", "knowledge_query",
  // Web access
  "web_search", "fetch_content", "get_search_content",
]);

interface ToolGate {
  names: string[];
  keywords: string[];
  /** One-line description — used for enable_tool intent matching + list output. */
  description: string;
  /** Approximate tokens saved when gated (for logging) */
  savedTokens: number;
}

/**
 * Gated tool groups — each activates when the prompt contains any keyword.
 * Keywords are matched case-insensitively as simple substring checks.
 */
export const GATES: ToolGate[] = [
  {
    names: ["flux2", "flux2_help"],
    keywords: [
      "flux", "image", "圖像", "圖片", "生成圖", "generate image",
      "t2i", "scene", "style", "swap", "outpaint", "upscale image",
      "flux2", "render", "把...做成",
    ],
    description: "Flux2 image generation — text-to-image, i2i, faceswap, outpaint, upscale, restore",
    savedTokens: 1411,
  },
  {
    names: ["krea2", "krea2_help"],
    keywords: ["krea", "draft", "草圖", "快速生成"],
    description: "Krea2 fast image generation — real-time draft to image",
    savedTokens: 641,
  },
  {
    names: ["ltx", "ltx_help"],
    keywords: [
      "ltx", "video", "影片", "視頻", "電影", "動畫",
      "t2v", "i2v", "vbvr", "relay", "storyboard",
      "generate video", "生成影片", "生成視頻",
    ],
    description: "LTX video generation — text/image-to-video, upscale, storyboard, relay",
    savedTokens: 1802,
  },
  {
    names: ["file2md", "vision_ask"],
    keywords: [
      "file2md", "vlm", "describe", "caption", "ocr", "識別", "讀圖",
      "分析圖片", "分析圖像", "read this image", "what is in",
      "pdf", "scan", "to markdown", "轉 markdown", "vision",
    ],
    description: "Document/image understanding — file→markdown, VLM describe, OCR, caption",
    savedTokens: 685,
  },
  {
    names: ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology"],
    // S1: narrowed — removed the over-broad "context" / "token" / "debug" which fired on
    // ~every dev turn and made inspect effectively always-on. Kept phrase-level terms.
    keywords: [
      "inspect", "schema cost", "pathology", "extension health",
      "工具開銷", "context window", "token usage",
    ],
    description: "Agent/extension introspection — context tokens, extension health, pathology",
    savedTokens: 770,
  },
  {
    names: ["workflow", "workflow_help"],
    keywords: [
      "workflow", "pipeline", "orchestrate", "fan.out", "parallel agent",
      "multi-step", "chain",
    ],
    description: "Workflow orchestrator — multi-agent fan-out/pipeline JavaScript scripts",
    savedTokens: 706,
  },
  {
    names: ["collect_videos", "organize_vault_notes", "import_memory_to_vault"],
    keywords: [
      "collect", "bilibili", "youtube", "video trending",
      "vault notes", "organize", "import memory",
    ],
    description: "Research tools — collect trending videos, organize vault notes, import memory",
    savedTokens: 723,
  },
  {
    // S1/B: movie was ungated (fail-open ⇒ always active). Now gated. savedTokens measured
    // 2026-07-20 via schema-cost (movie=348 + movie_help=284, charsPerToken=4).
    names: ["movie", "movie_help"],
    keywords: [
      "movie", "montage", "preflight", "compose",
      "storyboard", "分鏡", "剪輯", "影片製作", "導演",
    ],
    description: "Movie orchestrator — idea→script→scene→assets→edit→compose pipeline",
    savedTokens: 632,
  },
];

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
	setTimeout(() => {
		try {
			ctx.ui.setWidget("tool-gate", lines);
		} catch {
			return; // ctx stale after session switch — banner is non-essential
		}
		// Auto-dismiss after DISPLAY_MS. Guarded the same way: a session switch
		// between show and dismiss leaves ctx stale.
		setTimeout(() => {
			try {
				ctx.ui.setWidget("tool-gate", undefined);
			} catch {
				/* ctx stale after session switch */
			}
		}, DISPLAY_MS);
	}, SHOW_DELAY_MS);
}

// ── Extension entry ──────────────────────────────────────────────

/**
 * Compute which tools should be active for this turn.
 *
 * `sticky` is the accumulator of every tool activated so far THIS SESSION —
 * it starts as a copy of CORE_TOOLS and callers mutate it in place across
 * turns, so a gate that fires once stays active for the rest of the session
 * (a workflow using flux2 must not lose the tool mid-task just because a
 * follow-up prompt like "make it bigger" doesn't repeat the trigger keyword).
 *
 * Fail-open for UNKNOWN tools: only tools this file explicitly tracks (in
 * CORE_TOOLS or a GATES entry) are ever gated off. A tool from a new/renamed
 * extension that this file hasn't been updated for is never hidden — gating
 * is an opt-in allowlist for a KNOWN heavy set, not a default-deny for
 * everything else.
 */
export function computeActiveTools(
  prompt: string,
  allToolNames: string[],
  sticky: Set<string>,
): string[] {
  const promptLower = prompt.toLowerCase();

  const known = new Set(CORE_TOOLS);
  for (const gate of GATES) for (const name of gate.names) known.add(name);

  for (const gate of GATES) {
    const matches = gate.keywords.some((kw) => promptLower.includes(kw));
    if (matches) {
      for (const name of gate.names) sticky.add(name);
    }
  }

  return allToolNames.filter((name) => !known.has(name) || sticky.has(name));
}

/**
 * Find dormant gates whose **keywords** are a substring of `intent`. Pure: no
 * pi dependency. Used by enable_tool's intent mode. Returns gates in declaration
 * order; empty = no match.
 *
 * "Dormant" = not all of the gate's tools are already in `sticky`. A gate matches
 * if any keyword appears as a substring of the (lowercased) intent.
 *
 * NOTE: matching is keywords-only, NOT keywords∪description. Description-word
 * matching was prototyped and rejected: prose words like "image"/"pipeline"
 * appear in several gates' descriptions and over-match (krea2/movie fired on
 * intents that should hit only flux2/workflow). The `description` field is still
 * valuable for the human-readable `list` output (T5) and a future semantic
 * matcher, but not for substring matching. Verified 2026-07-20.
 */
export function matchIntent(
  intent: string,
  gates: ToolGate[],
  sticky: Set<string>,
): ToolGate[] {
  const needle = intent.toLowerCase();
  return gates.filter((g) => {
    if (g.names.every((n) => sticky.has(n))) return false; // skip already-active
    const fields = g.keywords.map((k) => k.toLowerCase());
    return fields.some((f) => f.length > 0 && needle.includes(f));
  });
}

// ── Telemetry (S3-lite, baked in) ─────────────────────────────────
// stderr by default; opt-in JSONL file via TOOL_GATE_LOG_PATH; disable via
// TOOL_GATE_LOG=0. Non-essential: write failures are swallowed. Purpose:
// quantify the dormant-tool miss rate (the "miss_candidate" kind) so the
// escape-hatch risk becomes measurable instead of structural-but-invisible.

export interface ToolGateLogEntry {
  kind: "turn" | "activate" | "miss_candidate";
  ts: string;
  [k: string]: unknown;
}

export function emitToolGateLog(entry: ToolGateLogEntry): void {
  if (process.env.TOOL_GATE_LOG === "0") return;
  const line = JSON.stringify(entry);
  try {
    const file = process.env.TOOL_GATE_LOG_PATH;
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

export default function toolGateExtension(pi: ExtensionAPI) {
  let allToolNames: string[] = [];
  let sticky = new Set<string>(CORE_TOOLS);

  // ── On session start: capture full tool list and gate ──
  pi.on("session_start", async (_event, ctx) => {
    allToolNames = pi.getAllTools().map((t: { name: string }) => t.name);
    sticky = new Set(CORE_TOOLS);

    const active = computeActiveTools("", allToolNames, sticky);
    pi.setActiveTools(active);

    const saved = GATES.filter(
      (g) => !g.names.some((n) => active.includes(n)),
    ).reduce((sum, g) => sum + g.savedTokens, 0);

    // Transient above-editor banner (like the /goal banner), delayed 5s past
    // the startup notify burst. setWidget is keyed ("tool-gate"), so this never
    // clobbers — or is clobbered by — other extensions' banners; that
    // independence is what previously forced the lossy notify("info") (pi merges
    // consecutive startup info-notifies, later overwriting earlier, so the
    // tool-gate confirmation line could vanish depending on notify ordering).
    // Mirrors pi-agent-ext-obsidian's scheduleVaultBanner and pi-agent-ext-zai-
    // mcp's scheduleReadyBanner (commit 58a6b0b5). In non-interactive (RPC /
    // print) modes setWidget is a silent no-op while theme is still present, so
    // this degrades gracefully with no output.
    //
    // TOOL_GATE_DEBUG_BANNER=1 fires the banner immediately (no 5s delay) and
    // mirrors the rendered lines to stderr — lets you confirm the trigger +
    // exact message in print/RPC/noOpUIContext where setWidget is a no-op.
    const debug = process.env.TOOL_GATE_DEBUG_BANNER === "1";
    const theme = ctx.ui.theme;
    scheduleToolGateBanner(
      ctx,
      [
        theme.fg("accent", `🔧 Tool gate: ${active.length}/${allToolNames.length} active`),
        theme.fg("dim", `saves ~${saved} tok/req`),
      ],
      debug ? { immediate: true, log: true } : undefined,
    );
  });

  // ── Per-turn: re-evaluate gates based on prompt (sticky — never un-gates) ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const prompt = event.prompt ?? "";
    const active = computeActiveTools(prompt, allToolNames, sticky);
    pi.setActiveTools(active);
  });
}
