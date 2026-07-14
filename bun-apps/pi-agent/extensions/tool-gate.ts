/**
 * Dynamic Tool Gate Extension — reduces API tools schema overhead
 *
 * Keeps core tools always active while gating heavy domain-specific tools
 * (flux2, ltx, krea2, vlm, inspect, workflow, research) behind prompt
 * keyword matching.
 *
 * Baseline:  41 tools → ~18,500 tok/req
 * Gated:    ~27 tools → ~10,000 tok/req  (saves ~8,500 tok per turn)
 *
 * Tools reactivate instantly when the prompt mentions relevant keywords.
 *
 * Install: registered in bun-apps/pi-agent/run-dir/manifest.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Tool categories ──────────────────────────────────────────────

/** Tools that must always be available (core workflow) */
const CORE_TOOLS = new Set([
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
    names: ["vlm_describe", "vlm_ask"],
    keywords: [
      "vlm", "describe", "caption", "ocr", "識別", "讀圖",
      "分析圖片", "分析圖像", "read this image", "what is in",
      "pdf", "scan",
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

export default function toolGateExtension(pi: ExtensionAPI) {
  let allToolNames: string[] = [];

  function computeActiveTools(prompt: string): string[] {
    const promptLower = prompt.toLowerCase();

    // Start with core tools
    const active = new Set(CORE_TOOLS);

    // Add tools whose gate keywords match
    for (const gate of GATES) {
      const matches = gate.keywords.some((kw) => promptLower.includes(kw));
      if (matches) {
        for (const name of gate.names) {
          active.add(name);
        }
      }
    }

    // Only return tools that actually exist
    return allToolNames.filter((name) => active.has(name));
  }

  // ── On session start: capture full tool list and gate ──
  pi.on("session_start", async (_event, ctx) => {
    allToolNames = pi.getAllTools().map((t: { name: string }) => t.name);

    const active = computeActiveTools("");
    pi.setActiveTools(active);

    const gatedCount = allToolNames.length - active.length;
    const saved = GATES.filter(
      (g) => !g.names.some((n) => active.includes(n)),
    ).reduce((sum, g) => sum + g.savedTokens, 0);

    ctx.ui.notify(
      `🔧 Tool gate: ${active.length}/${allToolNames.length} active (saves ~${saved} tok/req)`,
      "info",
    );
  });

  // ── Per-turn: re-evaluate gates based on prompt ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const prompt = event.prompt ?? "";
    const active = computeActiveTools(prompt);
    pi.setActiveTools(active);
  });
}
