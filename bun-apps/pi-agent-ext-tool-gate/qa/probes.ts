/**
 * Layer-1 probe corpus (wayfinder ticket 01; updated by the fix effort 2026-07-23).
 *
 * The deterministic capability signal — asserts tool-gate's keyword/co-occurrence
 * matching behaves as intended, with NO agent run and NO LLM. Run via `bun test`.
 *
 *   - MUST_FIRE     intent-bearing prompts that MUST activate the gate
 *   - MUST_NOT_FIRE lookalikes that share surface words but lack intent
 *   - ESCAPE_NAME   every gate reachable via enable_tool({ name })
 *   - ESCAPE_INTENT an intent that surfaces the gate via enable_tool({ intent })
 *
 * Reported-only registries (logged, never fail the suite):
 *   - PRECISION_RISKS       prompts that FALSE-FIRE today (benign; never gate)
 *   - OVERLAPS              keywords claimed by ≥2 gates (ambiguous routing)
 *   - ESCAPE_INTENT_BLIND   reasonable intents intent-mode CANNOT reach
 *
 * Post-fix (2026-07-23) state: the 4 task-breaking gates are closed —
 * krea2 ("real-time"/"sketch") and movie ("scenes into"/"short film") now reach
 * via intent; inspect's false-fire ("inspect element") is killed by `requires`;
 * storyboard overlap resolved (movie owns it). The two former blind intents
 * below were over-broad (generic "web search" → core web_search, not redundant
 * zai-mcp; verbless "agent diagnostics" structurally can't satisfy noun∧verb) —
 * their realistic L2 tasks all fire, so the gates are reachable for real use.
 *
 * Gate identity = GATES[].names[0].
 */

export interface Probe {
	/** Gate identity = GATES[].names[0]. */
	gate: string;
	prompt: string;
	note?: string;
}

export interface EscapeIntentProbe extends Probe {
	intent: string;
}

export interface PrecisionRisk {
	gate: string;
	prompt: string;
	why: string;
	severity: "high" | "med" | "low";
}

// ── MUST_FIRE ───────────────────────────────────────────────────────────────

export const MUST_FIRE: Probe[] = [
	// flux2 (requires: noun∧verb OR keyword)
	{ gate: "flux2", prompt: "generate an image of a cat", note: "noun image ∧ verb generate" },
	{ gate: "flux2", prompt: "draw me a picture of the scene", note: "noun picture ∧ verb draw" },
	{ gate: "flux2", prompt: "use flux to render a poster", note: "keyword flux" },
	{ gate: "flux2", prompt: "幫我把這張照片去背", note: "keyword 去背" },
	{ gate: "flux2", prompt: "txt2img a snowy landscape", note: "keyword txt2img" },
	// krea2 (keyword — now incl. English sketch/real-time after the fix)
	{ gate: "krea2", prompt: "use krea2 for a quick draft", note: "keyword krea2" },
	{ gate: "krea2", prompt: "快速生成一張草圖", note: "keyword 快速生成 / 草圖" },
	{ gate: "krea2", prompt: "turn this rough sketch into an image in real time", note: "keyword sketch / real time (fix closed the blind gap)" },
	// ltx (requires OR keyword)
	{ gate: "ltx", prompt: "generate a video of the scene", note: "noun video ∧ verb generate" },
	{ gate: "ltx", prompt: "make a short video clip", note: "noun video ∧ verb make" },
	{ gate: "ltx", prompt: "use ltx for t2v", note: "keyword ltx / t2v" },
	{ gate: "ltx", prompt: "加入影片特效", note: "keyword 影片特效" },
	// file2md (requires OR keyword)
	{ gate: "file2md", prompt: "ocr this scanned pdf and extract the text", note: "keyword ocr (+ noun pdf ∧ verb extract)" },
	{ gate: "file2md", prompt: "read this image and describe it", note: 'keyword "read this image"' },
	{ gate: "file2md", prompt: "把這份文件轉 markdown", note: 'keyword "轉 markdown"' },
	// inspect (keyword OR requires noun∧verb; bare "inspect" removed → no more "inspect element" false-fire)
	{ gate: "inspect_context", prompt: "inspect the agent state", note: "requires: noun agent ∧ verb inspect" },
	{ gate: "inspect_context", prompt: "what's the schema cost here", note: 'keyword "schema cost"' },
	{ gate: "inspect_context", prompt: "show me the token usage", note: 'keyword "token usage"' },
	// workflow (keyword only)
	{ gate: "workflow", prompt: "orchestrate a pipeline of agents", note: "keyword orchestrate / pipeline" },
	{ gate: "workflow", prompt: "fan out to parallel agents", note: 'keyword "fan out" / "parallel agent" (fan.out dead-keyword fixed)' },
	// research (keyword only)
	{ gate: "collect_videos", prompt: "collect videos from bilibili", note: "keyword bilibili / collect videos" },
	{ gate: "collect_videos", prompt: "幫我整理筆記", note: "keyword 整理筆記" },
	{ gate: "collect_videos", prompt: "pull youtube trending", note: "keyword youtube" },
	// movie (keyword only — incl. film phrases after the fix)
	{ gate: "movie", prompt: "make a movie from these scenes", note: 'keyword "make a movie"' },
	{ gate: "movie", prompt: "orchestrate these scenes into a short film", note: 'keyword "short film" / "scenes into" (fix closed the misroute)' },
	{ gate: "movie", prompt: "幫我畫一份分鏡表", note: "keyword 分鏡" },
	{ gate: "movie", prompt: "導演一部短片中", note: "keyword 導演" },
	// zai-mcp (keyword only — incl. "z.ai" after the fix)
	{ gate: "zai_web_search_web_search_prime", prompt: "use zai search for this", note: 'keyword "zai search"' },
	{ gate: "zai_web_search_web_search_prime", prompt: "read this webpage with Z.ai's reader endpoint", note: 'keyword "z.ai" (fix closed the blind gap)' },
	// pi_deploy (upstream gate — wraps deploy.ts + run-test.sh)
	{ gate: "pi_deploy", prompt: "build and deploy the pi-agent bundle", note: 'keyword deploy / build bundle' },
	{ gate: "pi_deploy", prompt: "部署 pi-agent 建置", note: "keyword 部署 / 建置" },
	// arxiv (keyword arxiv OR requires noun∧verb)
	{ gate: "arxiv_search", prompt: "find papers on diffusion policies", note: "noun papers ∧ verb find" },
	{ gate: "arxiv_search", prompt: "fetch the arxiv paper 2401.12345", note: "keyword arxiv" },
	{ gate: "arxiv_search", prompt: "搜尋論文 robotics", note: "keyword 論文 / 搜尋論文" },
	// cost (requires noun∧verb — bare 'cost' is NOT a keyword)
	{ gate: "cost", prompt: "estimate the cost of this production", note: "noun cost ∧ verb estimate" },
	{ gate: "cost", prompt: "calculate the budget breakdown", note: "noun budget ∧ verb calculate/breakdown" },
	{ gate: "cost", prompt: "這部片的成本估算", note: "keyword 成本估算" },
];

// ── MUST_NOT_FIRE (lookalikes the gate CORRECTLY rejects) ────────────────────

export const MUST_NOT_FIRE: Probe[] = [
	{ gate: "flux2", prompt: "docker image pull failed", note: "noun image but no gen-verb" },
	{ gate: "flux2", prompt: "the image size is 1024x768", note: "noun image, no verb" },
	{ gate: "krea2", prompt: "korean food recipe", note: "no krea keyword (not a substring)" },
	{ gate: "krea2", prompt: "draft a quick reply", note: "no krea keyword" },
	{ gate: "ltx", prompt: "video call at 3pm", note: "noun video but no gen-verb — the requires win" },
	{ gate: "ltx", prompt: "the video is buffering", note: "noun video, no verb" },
	{ gate: "file2md", prompt: "read the log file", note: "verb read but no pdf/image/doc noun" },
	{ gate: "file2md", prompt: "describe the architecture", note: "verb describe but no noun" },
	{ gate: "inspect_context", prompt: "inspect element in chrome devtools", note: "FIXED — 'element' is not a requires noun; bare 'inspect' removed" },
	{ gate: "inspect_context", prompt: "how is the agent doing", note: "noun agent but no inspect-verb" },
	{ gate: "workflow", prompt: "plan the remaining work", note: "no workflow keyword" },
	{ gate: "workflow", prompt: "a sequence of steps", note: "no workflow keyword" },
	{ gate: "collect_videos", prompt: "organize my local files", note: '"organize vault" not present' },
	{ gate: "collect_videos", prompt: "import a python module", note: '"import memory" not present' },
	{ gate: "movie", prompt: "I watched a movie last night", note: 'bare "movie" is not a keyword' },
	{ gate: "movie", prompt: "film the event with my phone", note: "no movie/film keyword" },
	{ gate: "zai_web_search_web_search_prime", prompt: "search the web for this", note: "generic web search → core web_search, not redundant zai-mcp" },
	{ gate: "zai_web_search_web_search_prime", prompt: "zai is a company in Shanghai", note: 'bare "zai" is not a keyword' },
	{ gate: "pi_deploy", prompt: "build the docker image", note: "no deploy/verify/bundle-pi-agent keyword (docker ≠ pi-agent deploy)" },
	{ gate: "arxiv_search", prompt: "paper cut on my hand", note: "noun paper but no retrieval verb" },
	{ gate: "cost", prompt: "what's the cost of this", note: "noun cost but no estimate-verb — bare cost not a keyword" },
	{ gate: "cost", prompt: "token cost is too high", note: "noun cost, no verb (dev/infra context)" },
];

// ── ESCAPE_NAME — every gate reachable by enable_tool({ name }) ──────────────

export const ESCAPE_NAME: { gate: string; name: string }[] = [
	{ gate: "flux2", name: "flux2" },
	{ gate: "krea2", name: "krea2" },
	{ gate: "ltx", name: "ltx" },
	{ gate: "file2md", name: "file2md" },
	{ gate: "inspect_context", name: "inspect_context" },
	{ gate: "workflow", name: "workflow" },
	{ gate: "collect_videos", name: "collect_videos" },
	{ gate: "movie", name: "movie" },
	{ gate: "zai_web_search_web_search_prime", name: "zai_web_search_web_search_prime" },
	{ gate: "pi_deploy", name: "pi_deploy" },
	{ gate: "arxiv_search", name: "arxiv_search" },
	{ gate: "cost", name: "cost" },
];

// ── ESCAPE_INTENT — intents that DO surface the gate (asserted match) ───────

export const ESCAPE_INTENT: EscapeIntentProbe[] = [
	{ gate: "flux2", intent: "generate an image", prompt: "(no keyword)", note: "noun∧verb" },
	{ gate: "krea2", intent: "real-time draft to image", prompt: "(no keyword)", note: "keyword real-time (was blind pre-fix)" },
	{ gate: "ltx", intent: "make a video", prompt: "(no keyword)", note: "noun∧verb" },
	{ gate: "file2md", intent: "ocr a pdf", prompt: "(no keyword)", note: "keyword ocr" },
	{ gate: "inspect_context", intent: "inspect the agent", prompt: "(no keyword)", note: "requires: noun agent ∧ verb inspect" },
	{ gate: "workflow", intent: "orchestrate a pipeline", prompt: "(no keyword)", note: "keyword orchestrate" },
	{ gate: "collect_videos", intent: "collect videos from youtube", prompt: "(no keyword)", note: "keywords" },
	{ gate: "movie", intent: "orchestrate scenes into a film", prompt: "(no keyword)", note: 'keyword "scenes into"/"film" (was a misroute pre-fix)' },
	{ gate: "zai_web_search_web_search_prime", intent: "use z.ai reader", prompt: "(no keyword)", note: 'keyword "z.ai" (was blind pre-fix)' },
	{ gate: "pi_deploy", intent: "build and deploy the bundle", prompt: "(no keyword)", note: 'keyword deploy / build bundle' },
	{ gate: "arxiv_search", intent: "find papers on a topic", prompt: "(no keyword)", note: "noun papers ∧ verb find" },
	{ gate: "cost", intent: "estimate the production cost", prompt: "(no keyword)", note: "noun cost ∧ verb estimate" },
];

// ── ESCAPE_INTENT_BLIND — empty after the fix (all gates reachable by intent) ─
//   Former entries removed with rationale (see file header): krea2 + movie
//   genuinely closed; zai-mcp ("web search and reader") was generic → core
//   web_search; inspect ("agent diagnostics and health") was a verbless label
//   that structurally can't satisfy noun∧verb. Their realistic L2 tasks fire.

export const ESCAPE_INTENT_BLIND: EscapeIntentProbe[] = [];

// ── PRECISION_RISKS — benign false-fires that remain (never gate) ────────────
//   inspect "inspect element" is FIXED (removed). These 5 are the low-harm
//   over-matches the verdict (ticket 05) chose to leave non-gating.

export const PRECISION_RISKS: PrecisionRisk[] = [
	{ gate: "flux2", prompt: "make the docker image smaller", why: 'noun "image" ∧ verb "make" (requires over-matches dev/infra)', severity: "med" },
	{ gate: "ltx", prompt: "make the video buffer larger", why: 'noun "video" ∧ verb "make" (dev/infra context)', severity: "med" },
	{ gate: "workflow", prompt: "the gitlab pipeline failed", why: 'keyword "pipeline" fires on CI/CD context', severity: "med" },
	{ gate: "workflow", prompt: "review this multi-step todo list", why: 'keyword "multi-step" fires on a plain todo', severity: "med" },
	{ gate: "movie", prompt: "the movie director won an oscar", why: 'keyword "movie director" fires on a person', severity: "med" },
	{ gate: "pi_deploy", prompt: "verify the test results", why: 'bare "verify" fires on any verification request (upstream gate — broad keyword)', severity: "med" },
	{ gate: "arxiv_search", prompt: "read the white paper first", why: 'noun "paper" ∧ verb "read" (doc-reading, not arxiv retrieval)', severity: "low" },
	{ gate: "cost", prompt: "estimate the token cost", why: 'noun "cost" ∧ verb "estimate" (dev/infra, not movie-production)', severity: "low" },
];

// ── OVERLAPS — empty after the fix (storyboard removed from ltx; movie owns it) ─

export const OVERLAPS: { keyword: string; gates: string[] }[] = [];
