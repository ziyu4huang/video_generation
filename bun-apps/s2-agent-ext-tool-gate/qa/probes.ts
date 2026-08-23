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
	{ gate: "flux2", prompt: "做一張照片當封面", note: 'noun 照片 ∧ verb 做 (I-3 recall gain)' },
	// krea2 (keyword — now incl. English sketch/real-time after the fix)
	{ gate: "krea2", prompt: "use krea2 for a quick draft", note: "keyword krea2" },
	{ gate: "krea2", prompt: "快速生成一張草圖", note: "keyword 快速生成 / 草圖" },
	{ gate: "krea2", prompt: "turn this rough sketch into an image in real time", note: "keyword sketch / real time (fix closed the blind gap)" },
	// ltx (requires OR keyword)
	{ gate: "ltx", prompt: "generate a video of the scene", note: "noun video ∧ verb generate" },
	{ gate: "ltx", prompt: "make a short video clip", note: "noun video ∧ verb make" },
	{ gate: "ltx", prompt: "use ltx for t2v", note: "keyword ltx / t2v" },
	{ gate: "ltx", prompt: "加入影片特效", note: "keyword 影片特效" },
	{ gate: "ltx", prompt: "run the video relay pipeline", note: 'keyword "video relay" (relay narrowed from bare)' },
	// file2md (requires OR keyword)
	{ gate: "file2md", prompt: "ocr this scanned pdf and extract the text", note: "keyword ocr (+ noun pdf ∧ verb extract)" },
	{ gate: "file2md", prompt: "read this image and describe it", note: 'keyword "read this image"' },
	{ gate: "file2md", prompt: "把這份文件轉 markdown", note: 'keyword "轉 markdown"' },
	// workflow (keyword only)
	{ gate: "run_workflow", prompt: "orchestrate a pipeline of agents", note: "keyword orchestrate / pipeline" },
	{ gate: "run_workflow", prompt: "fan out to parallel agents", note: 'keyword "fan out" / "parallel agent" (fan.out dead-keyword fixed)' },
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
	// deploy_pi_agent_sh (upstream gate — wraps deploy.ts + run-test.ts)
	{ gate: "deploy_pi_agent_sh", prompt: "build and deploy the s2-agent bundle", note: "requires: noun bundle ∧ verb build/deploy" },
	{ gate: "deploy_pi_agent_sh", prompt: "部署 s2-agent 建置", note: "requires: noun s2-agent ∧ verb 部署/建置" },
	// arxiv (keyword arxiv OR requires noun∧verb)
	{ gate: "arxiv_search", prompt: "find papers on diffusion policies", note: "noun papers ∧ verb find" },
	{ gate: "arxiv_search", prompt: "fetch the arxiv paper 2401.12345", note: "keyword arxiv" },
	{ gate: "arxiv_search", prompt: "搜尋論文 robotics", note: "keyword 論文 / 搜尋論文" },
	// devops (ticket 03) — keyword-only gates captured once their source
	// registrars were wired into evaluate.ts's capture list.
	// merge_pr_after_local_ci + sweep_merged_branches each carry a DISTINCT keyword signature
	// (no overlap with any prior gate), so each is its own signature-group; one
	// must-fire per gate (a real keyword trigger) validates the whole group
	// (the coverageGap check groups by signature).
	// (memory_supersede probes removed with the gate — ticket 03 deleted the tool.)
	{ gate: "merge_pr_after_local_ci", prompt: "wait for PR 42 to merge", note: "keyword wait / pr / merge" },
	{ gate: "sweep_merged_branches", prompt: "sweep merged branches and clean up", note: "keyword sweep / branch / cleanup" },
	// devops registrar — the 5 remaining devops gates (run_local_ci, sync_default_branch,
	// run_devops_retrospect, prepare_feature_branch, verify_merge_landed) each carry a DISTINCT
	// keyword-SET signature (individual keywords like merge/verify/rebase/branch
	// overlap across devops gates, but the full {keywords} set is unique per gate
	// → a distinct coverage group). One must-fire + one must-not-fire per gate
	// closes their coverageGaps (the qa gate groups by full signature, so a
	// mono-probed group counts as covered).
	{ gate: "run_local_ci", prompt: "run typecheck and keep the build green before merge", note: "keyword typecheck / green / merge" },
	{ gate: "sync_default_branch", prompt: "sync the repo to the latest default branch", note: "keyword sync / default branch" },
	{ gate: "run_devops_retrospect", prompt: "do a post-run retrospect of the run", note: "keyword retrospect / post-run" },
	{ gate: "prepare_feature_branch", prompt: "prepare the feature branch off main", note: "keyword prepare / branch" },
	{ gate: "verify_merge_landed", prompt: "verify the merge scope is clean not contaminated", note: "keyword verify / merge / scope / contaminated" },
	// check_main_health (devops registrar) — its keyword set (main/health/green/red/
	// default branch/broken/status/ci/devops) is unique among devops gates → its
	// own signature-group; landed (e2cc0441) without corpus probes and was
	// reported as a coverage gap — closed here.
	{ gate: "check_main_health", prompt: "is main green right now", note: "keyword main / green" },
	// zk_* + knowledge_query (ticket 02 — demoted from core to on-demand gates).
	{ gate: "zk_card", prompt: "add a vault note about the lora fix", note: "keyword vault note" },
	{ gate: "zk_card", prompt: "find my card on argparse patterns", note: "keyword card + verb find (requires)" },
	{ gate: "zk_ask", prompt: "ask my vault about the training recipe", note: "keyword ask my vault" },
	{ gate: "zk_ask", prompt: "query my notes on attention heads", note: "nouns notes ∧ verb query (requires)" },
	{ gate: "zk_ingest", prompt: "converge the knowledge records into the vault", note: "keyword converge / knowledge" },
	{ gate: "zk_ingest", prompt: "ingest the .knowledge.jsonl records", note: "keyword ingest / knowledge.jsonl" },
	{ gate: "knowledge_query", prompt: "query the knowledge graph for lora cards", note: "keyword knowledge graph / query" },
	{ gate: "knowledge_query", prompt: "查卡片 matching the tag argparse", note: "keyword 查卡片" },
	// zk_fs (kcard-parity ticket 05 D32 — FS-style browse surface).
	{ gate: "zk_fs", prompt: "list the cards in the knowledge vault", note: "keyword list cards" },
	{ gate: "zk_fs", prompt: "grep the knowledge cards for lora", note: "keyword knowledge grep" },
	// ticket 02 demotions (hermes/web-access/wayfind/obsidian).
	{ gate: "skill_manage", prompt: "create a skill for running tests", note: "keyword create skill" },
	{ gate: "knowledge_search", prompt: "search the knowledge graph for the sampler gotcha", note: "keyword knowledge search" },
	{ gate: "knowledge_ingest", prompt: "ingest the knowledge records from the workflow export", note: "keyword knowledge ingest" },
	{ gate: "wayfind_effort", prompt: "what's the effort status for tool-gate", note: "keyword effort status" },
	{ gate: "get_search_content", prompt: "get the stored content for that response", note: "keyword stored content" },
	{ gate: "obsidian", prompt: "put this note into the vault", note: "keyword vault" },
	// NOTE: `browser` is deliberately absent — power-tool owns its own cases via
	// __GATE_PROBES__ and they are derived in (qa/collect-probes.ts). New gated
	// tools should follow that route, not this list.
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
	{ gate: "run_workflow", prompt: "plan the remaining work", note: "no workflow keyword" },
	{ gate: "run_workflow", prompt: "a sequence of steps", note: "no workflow keyword" },
	{ gate: "collect_videos", prompt: "organize my local files", note: '"organize vault" not present' },
	{ gate: "collect_videos", prompt: "import a python module", note: '"import memory" not present' },
	{ gate: "movie", prompt: "I watched a movie last night", note: 'bare "movie" is not a keyword' },
	{ gate: "movie", prompt: "film the event with my phone", note: "no movie/film keyword" },
	{ gate: "zai_web_search_web_search_prime", prompt: "search the web for this", note: "generic web search → core web_search, not redundant zai-mcp" },
	{ gate: "zai_web_search_web_search_prime", prompt: "zai is a company in Shanghai", note: 'bare "zai" is not a keyword' },
	{ gate: "deploy_pi_agent_sh", prompt: "build the docker image", note: "no deploy/verify/bundle-s2-agent keyword (docker ≠ s2-agent deploy)" },
	{ gate: "deploy_pi_agent_sh", prompt: "run the tests for this extension", note: "verb 'test' removed — testing an extension ≠ deploying s2-agent (audit I-5)" },
	{ gate: "arxiv_search", prompt: "paper cut on my hand", note: "noun paper but no retrieval verb" },
	// verb "inspect" IS in the verb list, but these prompts pair it with a noun
	// that is NOT in [agent,context,extension,pathology,token,schema,tui,工具]
	// → no noun∧verb co-occurrence → no keyword → correctly rejected.,,
	// devops (ticket 03) — lookalikes the gate CORRECTLY rejects (no keyword
	// present). Word-boundary matching matters: bare "delete" is not the
	// hyphenated "delete-branch" keyword — so it doesn't fire.
	// (memory_supersede / planning_stale / grill_decision probes removed with
	// their gates — ticket 03 deleted the tools from the surface.)
	{ gate: "merge_pr_after_local_ci", prompt: "summarize the open issues", note: "no pr/merge/wait keyword" },
	{ gate: "sweep_merged_branches", prompt: "delete the temp file", note: 'bare "delete" is not the "delete-branch" keyword' },
	// devops registrar — the 5 remaining devops gates (see MUST_FIRE). Lookalikes
	// in the git/build/advisory domain that correctly avoid EVERY keyword of the
	// named gate. gateFires is checked only against the gate in `gate:`, so
	// cross-gate keyword overlap (merge/verify/rebase/branch) is irrelevant —
	// only the named gate's own keyword set must be absent from the prompt.
	{ gate: "run_local_ci", prompt: "lint the staged changes", note: "no ci/test/typecheck/verify/gate/merge keyword" },
	{ gate: "sync_default_branch", prompt: "clone the repository into a fresh folder", note: "no sync/fetch/rebase/pull keyword" },
	{ gate: "run_devops_retrospect", prompt: "summarize what changed in this session", note: "no retrospect/review/anomaly keyword" },
	{ gate: "prepare_feature_branch", prompt: "commit the staged changes", note: "no prepare/rebase/branch keyword" },
	{ gate: "verify_merge_landed", prompt: "show the files changed by the last commit", note: "no verify/merge/scope keyword" },
	{ gate: "check_main_health", prompt: "write a haiku about trees", note: "no main/health/green/red/status/ci keyword" },
	// zk_* lookalikes (ticket 02): surface words (note/card/vault/knowledge)
	// WITHOUT the intent verb must NOT fire.
	{ gate: "zk_card", prompt: "I noted the card number on my desk", note: "note as verb, no vault/add/find intent" },
	{ gate: "zk_card", prompt: "please note that I left", note: "note as verb, no vault/card noun" },
	{ gate: "zk_ask", prompt: "ask the user for their name", note: "ask + user, not vault/notes" },
	{ gate: "zk_ask", prompt: "my notes app crashed", note: "notes but no ask/query verb" },
	{ gate: "zk_ingest", prompt: "the records show a converging trend", note: "converge as adjective, no ingest intent" },
	{ gate: "knowledge_query", prompt: "query the database directly", note: "query + database, no knowledge/card/graph noun" },
	{ gate: "zk_fs", prompt: "the filesystem is full on the server", note: "filesystem noun but no card/knowledge browse verb" },
	{ gate: "zk_fs", prompt: "list the open pull requests", note: "list verb but no cards/knowledge noun" },
	// ticket 02 demotions — lookalikes without the demoted intent.
	{ gate: "skill_manage", prompt: "the skills section of the README", note: "skill noun, no manage verb" },
	{ gate: "knowledge_search", prompt: "search the web for lora papers", note: "web search, not the knowledge graph" },
	{ gate: "knowledge_ingest", prompt: "ingest the error from the logs", note: "ingest + error, no knowledge record" },
	{ gate: "wayfind_effort", prompt: "effort is required here", note: "effort noun, no wayfind/planning verb" },
	{ gate: "get_search_content", prompt: "the search summary is above", note: "search noun, no stored-content retrieval verb" },
	{ gate: "obsidian", prompt: "organize the meeting notes", note: "organize + notes, no vault/obsidian keyword, no file/folder noun" },
	// NOTE: `browser` lookalikes moved to power-tool's __GATE_PROBES__.mustNotFire
	// — see the corresponding note in MUST_FIRE above.
];

// ── ESCAPE_NAME — every gate reachable by enable_tool({ name }) ──────────────

export const ESCAPE_NAME: { gate: string; name: string }[] = [
	{ gate: "flux2", name: "flux2" },
	{ gate: "krea2", name: "krea2" },
	{ gate: "ltx", name: "ltx" },
	{ gate: "file2md", name: "file2md" },
	{ gate: "run_workflow", name: "run_workflow" },
	{ gate: "collect_videos", name: "collect_videos" },
	{ gate: "movie", name: "movie" },
	{ gate: "zai_web_search_web_search_prime", name: "zai_web_search_web_search_prime" },
	{ gate: "deploy_pi_agent_sh", name: "deploy_pi_agent_sh" },
	{ gate: "arxiv_search", name: "arxiv_search" },
];

// ── ESCAPE_INTENT — intents that DO surface the gate (asserted match) ───────

export const ESCAPE_INTENT: EscapeIntentProbe[] = [
	{ gate: "flux2", intent: "generate an image", prompt: "(no keyword)", note: "noun∧verb" },
	{ gate: "krea2", intent: "real-time draft to image", prompt: "(no keyword)", note: "keyword real-time (was blind pre-fix)" },
	{ gate: "ltx", intent: "make a video", prompt: "(no keyword)", note: "noun∧verb" },
	{ gate: "file2md", intent: "ocr a pdf", prompt: "(no keyword)", note: "keyword ocr" },
	{ gate: "run_workflow", intent: "orchestrate a pipeline", prompt: "(no keyword)", note: "keyword orchestrate" },
	{ gate: "collect_videos", intent: "collect videos from youtube", prompt: "(no keyword)", note: "keywords" },
	{ gate: "movie", intent: "orchestrate scenes into a film", prompt: "(no keyword)", note: 'keyword "scenes into"/"film" (was a misroute pre-fix)' },
	{ gate: "zai_web_search_web_search_prime", intent: "use z.ai reader", prompt: "(no keyword)", note: 'keyword "z.ai" (was blind pre-fix)' },
	{ gate: "deploy_pi_agent_sh", intent: "build and deploy the bundle", prompt: "(no keyword)", note: 'keyword deploy / build bundle' },
	{ gate: "arxiv_search", intent: "find papers on a topic", prompt: "(no keyword)", note: "noun papers ∧ verb find" },
	// inspect); no keyword present, mirroring the noun∧verb escape pattern.,
];

// ── ESCAPE_INTENT_BLIND — empty after the fix (all gates reachable by intent) ─
//   Former entries removed with rationale (see file header): krea2 + movie
//   genuinely closed; zai-mcp ("web search and reader") was generic → core
//   web_search; inspect ("agent diagnostics and health") was a verbless label
//   that structurally can't satisfy noun∧verb. Their realistic L2 tasks fire.

export const ESCAPE_INTENT_BLIND: EscapeIntentProbe[] = [];

// ── PRECISION_RISKS — benign false-fires that remain (never gate) ────────────
//   inspect "inspect element" is FIXED (removed). audit I-1/I-2/I-4 (2026-07-25)
//   graduated want/need, bare 圖, and bare relay out of this registry (they no
//   longer fire). These are the low-harm over-matches the verdict (ticket 05)
//   chose to leave non-gating.

export const PRECISION_RISKS: PrecisionRisk[] = [
	// — requires over-matches: dev/infra contexts that pair a media noun with a
	//   generation verb. (want/need were DROPPED from verbs in audit I-1 — "I
	//   want an image" / "I need a video" no longer auto-fire; the loss is
	//   weak-intent recall, recovered via generate/create/make + enable_tool.
	//   bare CJK 圖 was replaced by 圖片/圖像 in I-2; bare relay was narrowed to
	//   "video relay"/"vbvr relay" in I-4 — "做一個圖表" and "relay the message"
	//   no longer false-fire.) Remaining over-matches use "make": —
	{ gate: "flux2", prompt: "make the docker image smaller", why: 'noun "image" ∧ verb "make" (requires over-matches dev/infra)', severity: "med" },
	{ gate: "ltx", prompt: "make the video buffer larger", why: 'noun "video" ∧ verb "make" (dev/infra context)', severity: "med" },
	// — bare/ambiguous keywords that fire on unrelated contexts —
	{ gate: "run_workflow", prompt: "the gitlab pipeline failed", why: 'keyword "pipeline" fires on CI/CD context', severity: "med" },
	{ gate: "run_workflow", prompt: "review this multi-step todo list", why: 'keyword "multi-step" fires on a plain todo', severity: "med" },
	{ gate: "movie", prompt: "the movie director won an oscar", why: 'keyword "movie director" fires on a person', severity: "med" },
	{ gate: "krea2", prompt: "sketch out the plan first", why: 'keyword "sketch" fires on planning/architecture context', severity: "med" },
	{ gate: "arxiv_search", prompt: "read the white paper first", why: 'noun "paper" ∧ verb "read" (doc-reading, not arxiv retrieval)', severity: "low" },
];

// ── OVERLAPS — empty after the fix (storyboard removed from ltx; movie owns it) ─

export const OVERLAPS: { keyword: string; gates: string[] }[] = [];
