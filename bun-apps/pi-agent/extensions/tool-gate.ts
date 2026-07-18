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

/**
 * Gated tool groups — each activates when the prompt contains any keyword.
 * Keywords are matched case-insensitively as simple substring checks.
 */
interface ToolGate {
  names: string[];
  keywords: string[];
  /** Approximate tokens saved when gated (for logging) */
  savedTokens: number;
}

const GATES: ToolGate[] = [
  {
    names: ["flux2", "flux2_help"],
    keywords: [
      "flux", "image", "圖像", "圖片", "生成圖", "generate image",
      "t2i", "scene", "style", "swap", "outpaint", "upscale image",
      "flux2", "render", "把...做成",
    ],
    savedTokens: 1411,
  },
  {
    names: ["krea2", "krea2_help"],
    keywords: ["krea", "draft", "草圖", "快速生成"],
    savedTokens: 641,
  },
  {
    names: ["ltx", "ltx_help"],
    keywords: [
      "ltx", "video", "影片", "視頻", "電影", "動畫",
      "t2v", "i2v", "vbvr", "relay", "storyboard",
      "generate video", "生成影片", "生成視頻",
    ],
    savedTokens: 1802,
  },
  {
    names: ["file2md", "vision_ask"],
    keywords: [
      "file2md", "vlm", "describe", "caption", "ocr", "識別", "讀圖",
      "分析圖片", "分析圖像", "read this image", "what is in",
      "pdf", "scan", "to markdown", "轉 markdown", "vision",
    ],
    savedTokens: 685,
  },
  {
    names: ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology"],
    keywords: [
      "inspect", "context", "token", "debug", "除錯", "調試",
      "schema", "extension", "pathology", "工具開銷",
      "how many tokens", "工具佔用",
    ],
    savedTokens: 770,
  },
  {
    names: ["workflow", "workflow_help"],
    keywords: [
      "workflow", "pipeline", "orchestrate", "fan.out", "parallel agent",
      "multi-step", "chain",
    ],
    savedTokens: 706,
  },
  {
    names: ["collect_videos", "organize_vault_notes", "import_memory_to_vault"],
    keywords: [
      "collect", "bilibili", "youtube", "video trending",
      "vault notes", "organize", "import memory",
    ],
    savedTokens: 723,
  },
];

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

    ctx.ui.notify(
      `🔧 Tool gate: ${active.length}/${allToolNames.length} active (saves ~${saved} tok/req)`,
      "info",
    );
  });

  // ── Per-turn: re-evaluate gates based on prompt (sticky — never un-gates) ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const prompt = event.prompt ?? "";
    const active = computeActiveTools(prompt, allToolNames, sticky);
    pi.setActiveTools(active);
  });
}
