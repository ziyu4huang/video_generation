// All dispatch-layer symbols come from @repo/s2-agent-core-runtime (the
// isolated-process spawn + run-persistence layer moved there as the #1733
// continuation): a portable-base-set extension must not declare a dependency
// on the subagent EXTENSION package (bun-apps/tests/dep-guard.test.ts).
import { getSubagentInFlightRegistry } from "@repo/s2-agent-core-runtime";
import { getSubagentRunPersistence } from "@repo/s2-agent-core-runtime";
import { spawnSubagentSubprocess } from "@repo/s2-agent-core-runtime";
import type { SubagentFailure } from "@repo/s2-agent-core-runtime";

/** Resolve a tool-name allowlist from an env var (comma-separated), falling
 *  back to `defaults` when unset/empty. Used by distill/garden so a custom
 *  workflow can override the tool set without code changes (Phase 5 / WS-B6).
 *  Empty/whitespace-only entries are dropped; an all-empty value falls back. */
export function toolAllowlist(envVar: string, defaults: string[]): string[] {
	const raw = process.env[envVar];
	if (!raw || !raw.trim()) return defaults;
	const parsed = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return parsed.length > 0 ? parsed : defaults;
}

/** Phase 5 / WS-C8 — verify the host satisfies the ExtensionAPI contract.
 *  `core` methods are hard-required (their absence means the extension can't
 *  function → throw); `secondary` methods are warned about, not fatal, so a
 *  forward-compatible host that dropped an unused hook isn't blocked. */
export function assertExtensionApi(pi: any): void {
	const core = ["registerTool"];
	const secondary = ["registerCommand", "on"];
	const missingCore = core.filter((m) => typeof pi?.[m] !== "function");
	if (missingCore.length > 0) {
		throw new Error(
			`pi-obsidian: host does not satisfy the ExtensionAPI contract — missing core method(s): ${missingCore.join(", ")}. ` +
				`Ensure @earendil-works/pi-coding-agent is up to date (the host vendors an inline copy of ExtensionAPI).`,
		);
	}
	const missingSecondary = secondary.filter((m) => typeof pi?.[m] !== "function");
	if (missingSecondary.length > 0) {
		console.error(
			`pi-obsidian: warning — host ExtensionAPI is missing secondary method(s): ${missingSecondary.join(", ")} (commands/events will be unavailable but tools still register).`,
		);
	}
}

// ---- Zettelkasten distillation subagent ----------------------------------

/** System prompt that turns the child `pi` process into a Zettelkasten distiller.
 *  Encodes the full methodology: atomic decomposition, the exact output template,
 *  whole-vault linking, MOC update, Traditional Chinese output. */
export const ZETTEL_SYSTEM_PROMPT = `你是一名 Zettelkasten 蒸餾助手。你的任務：把給定的輸入文件分解成「一個原子化想法 = 一張卡」的 Zettelkasten 筆記，寫入專案本地的 Obsidian vault。

## 核心原則
1. **原子化**：每張卡只承載一個可獨立成立、能被單獨引用的論點。若一段內容含多個獨立主張，拆成多張卡。
2. **用自己的話寫**：核心想法必須改寫重述，不是逐字抄錄來源。
3. **互聯**：每張卡的「## 連結」段落至少一條 wiki-link。先用 obsidian 工具（action:"search"）搜尋整個 vault 既存筆記，找出語義相關者，用 [[筆記標題]] 連結（取不含 .md 的檔名）。
4. **繁體中文輸出**：所有卡片內容以繁體中文撰寫（專有名詞、程式碼保留原文）。

## 處理流程（依序執行）
### ① 讀取與拆解
用 read 工具讀取指定的輸入檔。通讀後，列出所有可獨立成立的原子想法（不要重寫內容，只標邊界）。

### ② 逐張萃取
對每個原子想法，建立一張卡片，呼叫 obsidian 工具（action:"create"）寫入 vault 的指定資料夾。

### ③ 連結
對每張新卡，呼叫 obsidian 工具（action:"search"）搜尋整個 vault（不只 Zettelkasten/）找相關既存筆記，在「## 連結」段落填入 wiki-link。

### ④ 更新 MOC
每建好一張卡，用 obsidian 工具（action:"append_section"）把它的 wiki-link 加進 Tags/Index.md 對應的 tag 段落（若該 tag 段落不存在，先加段落標題）。

## 嚴格輸出格式（每張卡都必須完全符合此範本）
檔名：vault 的 <輸出資料夾>/<標題>.md，標題簡潔、首字母大寫、不含斜線。
\`\`\`
---
id: <YYYYMMDDHHmm 時間戳，每張卡不同>
created: <YYYY-MM-DD>
tags: [zettel, <主題1>, <主題2>]
sources: ["<輸入檔檔名或來源>"]
---

# <這張卡的原子化標題：一個論點>

## 核心想法
- <用你自己的話，2-4 句陳述這張卡的主張>

## 證據 / 脈絡
- <來源文件的支撐細節、範例、引用，可多條>

## 連結
- 相關：[[<既存筆記A>]]
- 延伸：[[<既存筆記B>]]
- 上層概念：[[Tags/Index#<主題tag>]]
\`\`\`

## 輸入大小指引（重要）
- 一張卡的蒸餾約略對應來源 1–3 段文字。若輸入檔很大（粗估超過 ~12KB，或明顯多於十幾個段落），**不要一次通讀後草草萃取**——會漏掉尾段。
- 改成分批處理：先完整萃取前半部的原子想法，逐張建立；再用 obsidian 工具（action:"read"）重新定位到未處理的段落繼續。每張卡仍須獨立、互連。
- 你無法精確量位元組，請用「段落數 / 是否出現捲動」當粗略指引，寧可多建一張卡也不要丟失論點。

## 範例卡（gold standard — 輸出請對齊此結構）
以下是「原子化筆記與互連」一張理想卡的長相（frontmatter 完整、用自己的話、至少一條已解析的 wiki-link）：
\`\`\`
---
id: 202607010930
created: 2026-07-01
tags: [zettel, 知識管理, 筆記法]
sources: ["input.md"]
---

# 原子化筆記優先於主題資料夾

## 核心想法
- 筆記的價值來自單一論點能被獨立引用與重組，而非被歸進某個資料夾就固定不動；原子化讓連結成為主要結構，資料夾只是輔助。

## 證據 / 脈絡
- 來源指出：把多個主張塞進同一張筆記，會讓它既難被引用也難被連結。
- 互連的密度比分類的整齊更能反映思考網絡。

## 連結
- 相關：[[Zettelkasten 方法概論]]
- 延伸：[[雙向連結與圖譜密度]]
- 上層概念：[[Tags/Index#知識管理]]
\`\`\`

## 規則
- tags[0] 永遠是 zettel。
- 每張卡 id 不可重複（用當下時間，逐張遞增分鐘）。
- 不重複建立內容相同的卡（若與既存卡語義高度重疊，仍建新卡但務必互連）。
- 只用提供的工具，不要使用 bash 或寫 vault 以外的路徑。

## 完成後（重要）
先以繁體中文回報：共建了幾張卡、逐張列出檔名與一句話摘要、指出建立的主要連結。簡潔即可。

**最後一行必須是一條結構化 JSON**（供父代理解析），格式如下，獨占一行，不要用 markdown 包裹：

    {"type":"pi_obsidian_result","notesCreated":<數字>,"notesUpdated":<數字>,"linksAdded":<數字>,"notes":["相對 vault 的檔名"],"errors":["若有的話"]}

若無法填的字段填 0 或空陣列。這條 JSON 是給程式讀的，不是給人讀的。`;

/**
 * Optional overrides for a spawned subagent. Without these the child uses the
 * pi default model and the caller-curated tool set; passing them lets an
 * extension tool control its subagent the same way the CLI does via
 * --model / --exclude-tools.
 */
export interface SubagentOptions {
	/** Model id, `provider/id`, or `provider/id:thinking` → child `--model`. */
	model?: string;
	/** Tool names to deny the child → child `--exclude-tools` (joined CSV). */
	excludeTools?: string[];
	/** Live-event observer: invoked for every parsed NDJSON event the child
	 *  emits (tool_execution_start/end, message_update, message_end, …). Use to
	 *  surface progress (see makeSubagentProgressLogger). Default: no-op. */
	onEvent?: (event: any) => void;
}

/** Build a live progress logger for a subagent run. Prints compact lines to
 *  stderr so long-running distill/garden runs are observable: confirms the
 *  subagent started, reports each note created, and exposes final tallies.
 *  Returns `{ onEvent, stats }` — pass `onEvent` as SubagentOptions.onEvent
 *  and read `stats()` after the run for a summary line. */
export function makeSubagentProgressLogger(label: string): {
	onEvent: (event: any) => void;
	stats: () => { created: number; failed: number; toolCalls: number };
} {
	let started = false;
	let created = 0;
	let failed = 0;
	let toolCalls = 0;
	const onEvent = (event: any) => {
		if (!event || typeof event.type !== "string") return;
		if (!started) {
			started = true;
			console.error(`  [${label}] subagent started`);
		}
		// The fat `obsidian` tool funnels every action through one toolName, and
		// --mode json may not stream tool_execution_start args — so detect a create
		// by its RESULT on tool_execution_end (create returns "Wrote <note> (N bytes)";
		// append/update front their own verbs). tool_execution_end reliably carries
		// toolName + result. This counter is live/best-effort — the authoritative
		// tally comes from the child's trailing pi_obsidian_result JSON.
		if (event.type === "tool_execution_end" && event.toolName === "obsidian") {
			toolCalls++;
			const resultText =
				typeof event.result === "string"
					? event.result
					: event.result?.content?.[0]?.text ?? event.result?.text ?? "";
			if (!event.isError && typeof resultText === "string" && resultText.startsWith("Wrote ")) {
				created++;
				console.error(`  [${label}] +note #${created}`);
			}
		}
	};
	return { onEvent, stats: () => ({ created, failed, toolCalls }) };
}

// ---- Subagent model resolution (Phase 2 / WS-B2) --------------------------
// A subagent's model was previously inherited blindly from OB_PARENT_MODEL.
// A weak/TC-unaware parent model silently degrades distill/garden output. We
// now: honor an explicit per-call model; fall back to a configured floor
// (OB_SUBAGENT_MODEL); refuse to INHERIT a known-weak parent model; and warn
// when no model is configured at all. The floor for TC-aware distill/garden is
// a config decision (open question #2 in the PRD) — OB_SUBAGENT_MODEL is the
// mechanism; weak-detection is pattern-based so it doesn't hardcode an id.

/** Substring patterns that mark a model as "weak" (small/fast tiers that are a
 *  poor floor for the TC-heavy distill/garden prompts). Used only to REFUSE
 *  inheritance and to WARN on explicit selection — never to silently clear an
 *  explicit caller choice. */
export const WEAK_MODEL_PATTERNS = [
	/haiku/i,
	/mini/i,
	/nano/i,
	/\bsmall\b/i,
	/-lite\b/i,
	/flash/i,
	/tiny/i,
	/nano[-_]?code/i,
];

/** Is this model id a known-weak tier? (substring match on the id.) */
export function isWeakModel(modelId: string | undefined): boolean {
	if (!modelId) return false;
	return WEAK_MODEL_PATTERNS.some((re) => re.test(modelId));
}

export interface ResolvedModel {
	model: string | undefined;
	/** Where the resolution came from — surfaced for logging/diagnostics. */
	source: "explicit" | "floor" | "inherited" | "default";
	warned: boolean;
}

/** Resolve the subagent model per WS-B2. Pure function — unit-tested without
 *  spawning. Resolution order:
 *    1. opts.model            (explicit — caller's choice; warn if weak)
 *    2. OB_SUBAGENT_MODEL     (configured floor — trusted, no weakness check)
 *    3. OB_PARENT_MODEL       (inherited — REFUSED if weak)
 *    4. undefined             (pi default — warn that no model is configured) */
export function resolveSubagentModel(opts: SubagentOptions = {}): ResolvedModel {
	const warn = (m: string) => console.error(`  [subagent] ⚠ ${m}`);
	// 1. Explicit per-call model: honor it, but warn on a known-weak choice.
	if (opts.model) {
		if (isWeakModel(opts.model))
			warn(`explicit model "${opts.model}" looks like a weak tier for TC distill/garden`);
		return { model: opts.model, source: "explicit", warned: isWeakModel(opts.model) };
	}
	// 2. Configured floor (OB_SUBAGENT_MODEL) — trusted; not weakness-checked.
	const floor = process.env.OB_SUBAGENT_MODEL;
	if (floor) return { model: floor, source: "floor", warned: false };
	// 3. Inherited parent model — refuse if known-weak so a parent `--model`
	//    selection can't silently degrade every spawned subagent.
	const parent = process.env.OB_PARENT_MODEL;
	if (parent) {
		if (isWeakModel(parent)) {
			warn(`refusing to inherit weak parent model "${parent}"; falling back to pi default`);
			return { model: undefined, source: "default", warned: true };
		}
		return { model: parent, source: "inherited", warned: false };
	}
	// 4. Nothing configured — let pi pick its default, but surface that no
	//    explicit/floor model is set so the operator can tune OB_SUBAGENT_MODEL.
	warn("no subagent model configured (set OB_SUBAGENT_MODEL for a stable TC-aware floor)");
	return { model: undefined, source: "default", warned: true };
}

/** A3.4: extract a trailing structured-result JSON object from assistant text.
 *  Looks for the LAST line that parses to an object with type 'pi_obsidian_result'.
 *  Returns the parsed object, or null if none found. Exported for testing. */
export function parseStructuredResult(text: string): any {
	if (!text) return null;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") || !trimmed.includes("pi_obsidian_result"))
			continue;
		try {
			const obj = JSON.parse(trimmed);
			if (obj && obj.type === "pi_obsidian_result") return obj;
		} catch {
			/* not valid JSON, keep scanning */
		}
	}
	return null;
}

export interface RunObsidianSubagentOptions {
	cwd: string;
	systemPrompt: string;
	task: string;
	tools: string[];
	signal?: AbortSignal;
	onEvent?: (event: any) => void;
}

/**
 * Run a distill/garden subagent through the shared subprocess wrapper
 * (`spawnSubagentSubprocess` from `@repo/s2-agent-ext-subagent`). Resolves the
 * model via obsidian's policy (`resolveSubagentModel`: OB_ env floor + refuse
 * weak parent), then delegates to the wrapper — which provides the contract
 * guarantees: §1 isolated child process, §2 model → `--model`, §3 retry/timeout,
 * §4 phantom telemetry (in-flight + run-persistence → `/subagents`). Parses the
 * child's trailing `pi_obsidian_result` JSON (`parseStructuredResult`) — the
 * wrapper returns raw assistant text; obsidian-specific parsing stays here.
 */
export async function runObsidianSubagent(
	opts: RunObsidianSubagentOptions,
): Promise<{ output: string; failure?: SubagentFailure; result: any }> {
	const resolved = resolveSubagentModel({});
	// 2026-08-18 budget rebalance: distill/garden children are the writer archetype
	// (read inputs, write notes) — wall clock aligned to the writer envelope (20 min,
	// ROLE_AWARE_DISPATCH_BOUNDS). The subprocess seam carries no token/turn fields,
	// so this is the leaf's only budget knob; env override OB_SUBAGENT_TIMEOUT_MS and
	// 0=no-gate semantics unchanged. Old 5-min default killed mid-distill runs
	// (partial notes).
	const res = await spawnSubagentSubprocess({
		cwd: opts.cwd,
		systemPrompt: opts.systemPrompt,
		task: opts.task,
		tools: opts.tools,
		model: resolved.model,
		externalSignal: opts.signal,
		onEvent: opts.onEvent,
		timeoutMs: Number(process.env.OB_SUBAGENT_TIMEOUT_MS ?? 20 * 60_000),
		// §4: register a phantom entry visible to /subagents (best-effort —
		// cross-extension singleton sharing determines viewer visibility).
		inFlight: getSubagentInFlightRegistry(),
		persistence: getSubagentRunPersistence(),
	});
	return { ...res, result: parseStructuredResult(res.output) };
}

// ---- Opt-in semantic re-index hook (vault-mind) ---------------------------
//
// Fired after `obsidian_distill` writes notes so the vault-mind ChromaDB index
// can be refreshed without a manual re-index step. Strictly opt-in via
// VAULT_MIND_AUTO_REINDEX (default OFF — closed principle preserved): when the
// env is unset/empty/"0"/"false"/"off"/"no" this issues ZERO HTTP and is a pure no-op.
// Fire-and-forget by design: an internal try/catch guarantees it NEVER throws
// into the distill caller or alters its tool result shape.

const REINDEX_TIMEOUT_MS = 10_000;

/** Fire-and-forget vault-mind re-index. Opt-in via VAULT_MIND_AUTO_REINDEX.
 *  Never throws — failures only warn. Honors README's /api/index force_reindex flow. */
export async function maybeTriggerReindex(
	vaultName: string,
	vaultPath: string,
	opts: { fetch?: typeof fetch; base?: string } = {},
): Promise<void> {
	const enabled = String(process.env.VAULT_MIND_AUTO_REINDEX ?? "").trim();
	if (!enabled || ["0", "false", "off", "no", ""].includes(enabled.toLowerCase())) return;
	const base = (opts.base ?? process.env.VAULT_MIND_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
	const f = opts.fetch ?? globalThis.fetch;
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), REINDEX_TIMEOUT_MS);
		await f(`${base}/api/index`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ vault_name: vaultName, vault_path: vaultPath, force_reindex: true }),
			signal: ctrl.signal,
		});
		clearTimeout(t);
	} catch (e) {
		console.warn(`[obsidian] semantic re-index skipped: ${(e as Error).message}`);
	}
}

// ---- Vault gardener subagent ---------------------------------------------

/** System prompt for the vault gardener: audits & repairs knowledge-base health. */
export const GARDEN_SYSTEM_PROMPT = `你是一名 Obsidian vault 圖丁（gardener），負責維護知識庫的健康度。你會掃描整個 vault，找出品質問題，依模式決定只回報或實際修復。

## 健康度檢查項（逐一執行）
用 obsidian 工具（action:"list"）列出所有筆記，用 obsidian 工具（action:"read"）讀內容，用 obsidian 工具（action:"search"）驗證連結，檢查：

每個發現都標註嚴重等級，回報與 JSON 都要帶：🔴 critical（結構損壞，必須處理）、🟡 warning（明確的健康問題）、🟢 info（改善機會，非錯誤）。

1. 🔴 **破損 wiki-link**：[[Target]] 指向不存在的筆記。
2. 🔴 **缺漏 / 損壞 frontmatter**：Zettelkasten/ 下的筆記應有 id / created / tags / sources 欄位；缺任一者、或 YAML 無法解析即回報。
3. 🟡 **孤兒卡（Orphan）**：沒有任何其他筆記用 wiki-link 指向它的筆記（Zettelkasten 筆記尤其不能孤兒）。對每張可疑卡，用 obsidian 工具（action:"search"）搜尋它的標題確認是否真無入連結。
4. 🟡 **疑似重複**：兩張以上筆記談論幾乎相同的論點。
5. 🟡 **MOC 漂移**：Tags/Index.md 缺少某些既存 tag 的段落，或某 tag 段落漏列了帶該 tag 的筆記。
6. 🟢 **漏連的相關筆記**：兩張筆記語義高度相關卻未互相 wiki-link——這是提升圖譜密度的高價值機會。

### 疑似重複的結構化前置篩選（避免對所有筆記兩兩比對）
不要直接對整個 vault 做語義兩兩比較（O(n²)、昂貴且不可重現）。先縮小候選集，只對候選集做語義判斷：
- 用 obsidian 工具（action:"search"）/ 索引找出 **共享 ≥2 個 tag** 的筆記群。
- 在同一群內，再挑**標題詞彙重疊**者（用 obsidian 工具（action:"search"）以標題中的關鍵詞查詢）。
- 只對這個候選短名單做語義判斷（是否談論幾乎相同的論點）。語義判斷要看主張內容，不是只看檔名或 tag 相同。

## 模式
- **audit（預設）**：只做檢查，不改動任何檔案。輸出一份結構化健康報告。
- **fix**：做完檢查後，對「安全且明確」的項目執行修復。**不確定就不改**。修復限於：
  - 為孤兒卡補上語義相關的 wiki-link（用 obsidian 工具（action:"append_section"）加到「## 連結」段落）。
  - 為漏連的相關筆記對補雙向連結。
  - 把缺漏的筆記補進 Tags/Index.md 對應 tag 段落（用 obsidian 工具的 append_section action）。
  - **不要**刪除或合併筆記，不要修改 frontmatter 的 id。疑似重複只回報，不自動合併。

## 輸出格式（繁體中文）
### 健康報告
為每個檢查項給一段：項目名、發現數量、逐條列出（每條標註嚴重等級 🔴/🟡/🟢 + 檔名 + 一句話問題描述）。
最後給「## 總結」：整體健康評分（1-5 ★）、最嚴重的 3 個問題、建議優先處理順序。

若為 fix 模式，在報告前加「### 已執行修復」段落，逐條列實際改了什麼（哪個檔案、加了什麼連結／更新了哪段）。

## 規則
- 只用提供的工具。fix 模式下只能用 obsidian 工具（action:"append_section"）/ obsidian 工具（action:"create"），不可刪檔。
- 所有路徑相對於 vault 根。
- 簡潔但完整。

## 完成後（重要）
報告完成後，**最後一行必須是一條結構化 JSON**（供父代理解析），格式如下，獨占一行，不要用 markdown 包裹：

    {"type":"pi_obsidian_result","notesCreated":<數字>,"linksAdded":<數字>,"notesModified":["fix 模式實際改動過的筆記檔名"],"issuesFound":<數字>,"issues":[{"kind":"orphan|dead-link|duplicate|missing-frontmatter|moc-drift","path":"檔名","severity":"critical|warning|info","detail":"一句話"}],"errors":["若有的話"]}

這條 JSON 是給程式讀的。數字字段若不適用填 0；audit 模式 notesModified 為空陣列。`;
