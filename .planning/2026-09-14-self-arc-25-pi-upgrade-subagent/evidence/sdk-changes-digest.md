證據鏈完成：0.84.4 的七個工具完全沒有 `ctx?.cwd`，0.85.1 全部改為 `ctx?.cwd || cwd`。所有資料齊全，輸出最終 digest。

---

# pi coding agent SDK: 0.84.4 → 0.85.1 技術摘要（LIBRARY/SDK 消費者視角）

研究方法：npm tarball 下載比對（0.84.4 / 0.85.0 / 0.85.1 三版完整 `dist/*.d.ts` + `docs/` + `package.json` diff）、GitHub `earendil-works/pi` 各 package CHANGELOG、npm registry metadata、releases API。所有引用皆為 tarball 實測，非推測。

**版本時間線**（npm publish 時間）：`0.84.4` 2026-08-28 → `0.85.0` 2026-09-04 → `0.85.1` 2026-09-05（`latest` = 0.85.1）。Release tags: `v0.85.0`, `v0.85.1`（https://github.com/earendil-works/pi/releases/tag/v0.85.1）。

---

## 1. 套件匯出面（exports map）— 0.85.1 最大結構性變更

**0.84.4 exports**（`package.json` 實測）：
```json
{
  ".":          { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./rpc-entry":{ "import": "./dist/bundle/rpc-entry.js" },
  "./client":   { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js" }
}
```
**0.85.0 exports**：同上，但新增 `"./experimental/plugin": { "source": "./src/experimental/plugin.ts", "types": "./dist/experimental/plugin.d.ts", "import": "./dist/experimental/plugin.js" }`（dist/experimental/ 目錄內含 coordinator、session-worker、radius-auth、server、client-tui 等 30+ 檔案全部隨 tarball 發佈）。

**0.85.1 exports**（實測）：
```json
{
  ".":           { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./rpc-entry": { "import": "./dist/bundle/rpc-entry.js" },
  "./client":    { "source": "./src/client/index.ts" },
  "./experimental/plugin": { "source": "./src/experimental/plugin.ts" }
}
```
變更點：
- `./client` 與 `./experimental/plugin` 只剩 `"source"` 條件 — **npm tarball 內既無 `src/` 也無 `dist/client/`、`dist/experimental/`**（實測 `find` 為空）。Node/bundler 標準解析下 `import "@earendil-works/pi-coding-agent/client"` 直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- CLI 的 `pi server` / `pi client` 子命令同時消失（0.84.4 tarball 有 `dist/cli/experimental/commands/{client,pi,server}.js`；0.85.1 無 `dist/cli/experimental/`）。
- 依賴變化：0.85.1 **移除 `@earendil-works/pi-client` 與 `@earendil-works/pi-protocol`** runtime 依賴，新增 `@earendil-works/chord`（npm 描述："Application composition runtime for services, replicated state, RPC, and plugins"，版本 0.85.0/0.85.1 對齊）。若你的 bundle 對 deps 做重複依賴消除（dedupe）/嚴格盤點（strict inventory），這三個套件的出現/消失要同步。
- 官方理由（CHANGELOG 0.85.1 Fixed）：「Fixed SDK import failures caused by unintentionally publishing internal experimental code and dependencies in 0.85.0. The experimental `client` and `experimental/plugin` subpaths and server/client commands are now source-only through `pi-test.sh`; the supported local SDK and stdio RPC API are unchanged」→ issue https://github.com/earendil-works/pi/issues/9132。0.85.0 自己也有條「Restored the `@earendil-works/pi-coding-agent/client` compatibility entry point」，可見這條 entry 在 0.85 系列反覆折騰。
- `dist/bun/cli.d.ts` 入口重構：0.84.4 是空 `export {}`（+ `register-bedrock`），0.85.1 改為 `import "./sandbox-env-setup.ts"; import "./runtime-setup.ts"; import "../cli.ts";`（新檔 `runtime-setup` / `sandbox-env-setup` 取代 `register-bedrock`）— 只影響走 `dist/bun` 入口的人。

**Root entry `dist/index.d.ts` 對 0.84.4 的 diff 只有 4 行**：新增導出 `type CustomEditorOptions`（`modes/interactive/components/index.d.ts` 加 `export { CustomEditor, type CustomEditorOptions }`）。換句話說「~220 symbols from root import」的匯入面在 0.85.1 **零刪除、零簽名變更、加一個型別**。`isBundledNode`、`ToolRenderers`、`setThemeJsonValidator` 等新內部 API 都**沒有**進 root index。

---

## 2. 新公開 API（0.85.0 / 0.85.1）

### 2.1 `SessionManager.inMemory()` restorable sessions（PR #8980, @y-nk）

`dist/core/session-manager.d.ts` 簽名變化（0.84.4 → 0.85.1）：
```ts
// 0.84.4
/** Create an in-memory session (no file persistence) */
static inMemory(cwd?: string, options?: NewSessionOptions): SessionManager;
// 0.85.1
/** Create an in-memory session (no file persistence), optionally from entries held outside the filesystem. */
static inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[]): SessionManager;
```
（另新增私有 `_loadEntries`。）第三參數是**向後相容的可選新增**，0.84.4 的兩參呼叫不變。

`docs/sdk.md`（#session-management，0.85.1 新增 5 行）：
```ts
// Resume a session kept outside the filesystem, e.g. in a database
const { session: restored } = await createAgentSession({
  sessionManager: SessionManager.inMemory(process.cwd(), { id: sessionId }, entries),
});
```
動機與用法（文檔 + 型別實證）：
- `FileEntry = SessionHeader | SessionEntry`（root index 已導出 `type FileEntry`），即 session JSONL 的逐行解析單位。`SessionEntry` union = `SessionMessageEntry | ThinkingLevelChangeEntry | ModelChangeEntry | CompactionEntry | BranchSummaryEntry | CustomEntry | CustomMessageEntry | LabelEntry | SessionInfoEntry`。
- 既有工具鏈完整支援外部儲存往返：`parseSessionEntries(content: string): FileEntry[]`（解析 JSONL 文本）、`migrateSessionEntries(entries: FileEntry[]): void`（舊格式就地遷移）、`loadEntriesFromFile(path)` — 三者皆已從 root index 導出（0.84.4 已有，非新增）。
- Orchestrator 模式（文檔 SessionManager tree API 段落）：持久端先 `sm.getEntries()` 取「All entries (excludes header)」存進自己的資料庫；要恢復時把條目（可含 header）交給 `inMemory(cwd, { id }, entries)` 重建分支樹（`getTree()`/`getBranch()`/`getEntry(id)` 照常運作），後續追加仍走記憶體、不落盤。配合既有 `runtime.fork("entry-id")` / `fork("entry-id", { position: "at" })`，可以在純記憶體中做 child session 的分支/複製/恢復 — 正是「keep child sessions in memory or restore them」的路徑。
- `inMemory` session 的 `isPersisted()` 回 `false`、`getSessionFile()` 回 `undefined`（sdk.md AgentSession 段落：「sessionFile: string | undefined」）。

### 2.2 Persistent Claude thinking effort（0.85.0 New Features；pi-ai 層實作）

`docs/models.md` 新增段落（#model-configuration，逐字引用）：
> Claude models with per-turn effort support use `supportsMidConvoEffort`. Pi then persists each response's provider effort, reconstructs effort-only system messages on later requests, and sends thinking binding controls with `prefix_mismatch_behavior: "drop_block"` to avoid stale signed-thinking prefixes causing persistent 400 responses. Set this only for the exact supported Claude model on a faithful Anthropic Messages transport; do not enable it for APIs that merely imitate the Messages shape.

新 compat 欄位表格行：`| supportsMidConvoEffort | Whether the exact Claude model transport supports per-turn effort system messages and thinking binding controls. ... Default: false. |`。pi-ai CHANGELOG 補充：「Added Anthropic per-turn effort persistence, deterministic historical effort markers, and signed-thinking mismatch recovery for supported Claude models across Anthropic Messages transports, including OpenRouter」+ 0.85.0 Fixed「Fixed proxied assistant responses dropping persisted provider-native thinking levels」（pi-agent-core）。

### 2.3 Model settings 新欄位（TypeBox schema，`dist/core/model-config.d.ts` 實測）

在 global/project/override 三層 schema 共 6 處同時新增（皆 `TOptional`，非破壞性）：
```ts
vllmPriority: Type.TOptional<Type.TNumber>;        // vLLM scheduler priority（#9004）
supportsMaxOutputTokens: Type.TOptional<Type.TBoolean>; // OpenAI Responses max_output_tokens 閘門（#8941）
supportsMidConvoEffort: Type.TOptional<Type.TBoolean>;  // Claude per-turn effort（見上）
```
runtime 語義（`openai-responses` chunk 實測）：`getCompat()` 中 `supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? !0`（**預設 true**）；`buildParams` 只在 `compat.supportsMaxOutputTokens` 為真時送 `max_output_tokens = Math.max(options.maxTokens, 16)`。

### 2.4 `prompt_cache_options.ttl: "30m"`（0.85.1 Fixed）

`docs/models.md` 的 `supportsLongCacheRetention` 描述更新：
> `prompt_cache_options.ttl: "30m"` for GPT-5.6+ Responses models, `prompt_cache_retention: "24h"` for earlier OpenAI models, or `cache_control.ttl: "1h"` when `cacheControlFormat` is `anthropic`. Default: `true`.

實測 runtime：新函式 `getPromptCacheOptions(compat, cacheRetention)` — 當 `compat.supportsExplicitPromptCacheMode` 為真：`cacheRetention==="none"` → `{mode:"explicit"}`；`"long"` 且 `supportsLongCacheRetention` → `{ttl:"30m"}`。舊 `getPromptCacheRetention`（`"24h"`）保留給非 explicit 模式的模型。參數同時送出：`prompt_cache_key`（clamp 過的 sessionId）+ 兩者擇一。對自訂 OpenAI 相容 proxy 的 embedder：**請求體欄位變了**。

### 2.5 GPT-6 Astra（0.85.1 New Features）

registry 實測條目（多 provider）：
- `gpt-6-astra` / "GPT-6 Astra"，GitHub Copilot（`openai-completions`）：`contextWindow: 1050000, maxTokens: 128000, cost {input:10, output:50, cacheRead:1, cacheWrite:12.5, tiers:[{inputTokensAbove:272000, input:20, output:75, ...}]}`, `thinkingLevelMap {xhigh:"xhigh", max:"max"}`，`compat {supportsStore:!1, supportsDeveloperRole:!1, supportsReasoningEffort:!1}`。
- Azure variant（`azure-openai-responses`）`contextWindow: 272000`；OpenAI API key 與 OpenAI Codex subscription 供應（CHANGELOG："Available through OpenAI API keys and OpenAI Codex subscriptions"，見 docs/providers.md#api-keys、#openai-codex）。

### 2.6 Fullscreen transcript / TUI 控制（0.85.0–0.85.1）

- `docs/keybindings.md`：scroll-up 時底部出現可點擊的 "Jump to latest message" 標籤（綁 `tui.altScreen.bottom`）（#9080）；transcript 搜尋面板顯示 prev/next 快捷鍵與可點擊箭頭，`tui.altScreen.searchClose` 關閉。
- 新 keybinding：`app.thinking.save` = `ctrl+s`（"Save thinking level"，與既有 `app.models.save` 並列；`DefaultKeybindings` map 新增 `"app.thinking.save": true`）。
- 0.85.1：按住 Alt 滾輪 5 倍速滾動（#9166，pi-tui 層）。
- `pi-tui` 0.85.0 Added：`TuiAltScreen` 的 `scrollToEndIndicator` 選項（可點擊 jump-to-end 標籤）。

### 2.7 其他新 API（d.ts diff 實測，root 未導出者標註）

| API | 位置 | 說明 |
|---|---|---|
| `type CustomEditorOptions = EditorOptions & { embedWorkingStatus?: boolean }` | `modes/interactive/components/custom-editor.d.ts`，**root 已導出** | `CustomEditor` 第 4 建構參數；`setWorkingStatusIndicator(indicator | undefined)`、`protected renderTopBorder()` 新方法。extensions.md：「Custom editors keep the standalone working row by default. Pass `{ embedWorkingStatus: true }` as the fourth `CustomEditor` constructor argument to use the built-in editor-border spinner instead.」 |
| `ModelRuntime.streamDeferred(model, handle: DeferredHandle, options?)` | `core/model-runtime.d.ts` | 新方法（deferred/fetch-later 模型串流，配合 pi-ai subpath 匯入優化） |
| `formatSkillsForPrompt(skills, fileReadTool?: "read" \| "bash")` | `core/skills.d.ts`，root 已導出 | 新可選參數 — 配合 #8552「skills unavailable when Bash is the only enabled tool」 |
| `getLatestVersion(repo: string): Promise<string>` | `utils/tools-manager.d.ts` | managed fd/rg 不再依賴 GitHub Releases API（#8708/#9070） |
| `isBundledNode: boolean` | `config.d.ts` | root 未導出 |
| `setThemeJsonValidator(validator)` / `type ThemeJson` / `ThemeJsonValidator` | `modes/interactive/theme/theme.d.ts` | 延遛載入 typebox 驗證（「~17 MB of module graph」註釋）；root 未導出 |
| `ThemeColor` 新增 `"scrollbarTrack"`；**`"scrollbarThumb"` 從 `ThemeBg` 移入 `ThemeColor`** | theme.d.ts，`ThemeColor`/`Theme` 經 root 導出 | exhaustive theme map 消費者會炸（見 RISK） |
| `StatusIndicator` 建構第 4 參 `colorFn?: (text) => string`、新 `renderInBorder(width)` / `renderSpinnerInBorder(width)` | status-indicator.d.ts | embedded working indicator（#8799） |
| `ThemeController.dispose()` | theme-controller.d.ts | 新清理方法 |
| `BranchSummaryMessage.fromId: string` → `string \| null` | `core/messages.d.ts`，root 導出 | 型別放寬（配合 branch summary fix） |
| pi-ai：`AssistantMessageFrameEncoder` + `reduceAssistantMessageFrames()`、`uuidv7(ts?)`、新 `./api/*`、`./providers/*`、`./utils/*` subpath exports | pi-ai 0.85.0 CHANGELOG | 傳遞依賴層的新能力 |

**Extension events：0.85.x 沒有新增任何 `pi.on` 事件**。`AgentSessionEvent` union 的唯一變化是刪除了一個**重複的** `auto_retry_end` 條目（0.84.4 宣告了兩次，0.85.1 保留一次；runtime 仍發射，實測 8 處引用）— 型別層去重，非語義變更。

---

## 3. 行為變更（可能改變 embedder 觀察到的行為）

### 3.1 Tool `ctx.cwd` fix（#8627，0.85.0 Fixed）— **高關注**

CHANGELOG 原文：「Fixed `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` tools ignoring `ctx.cwd`」。實測證據：0.84.4 的 `dist/core/tools/*.js` **七個工具完全沒有 `ctx?.cwd` 引用**（一律用工具工廠建構時捕獲的 `cwd`）；0.85.1 七個檔案全部出現 per-call 優先，例如 read.js: `const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd)`、bash.js: `resolveSpawnContext(resolvedCommand, ctx?.cwd || cwd, ...)`。
對 embedder 的意義：若你在 `createCodingTools`/`createAgentSession` 時傳 cwd A，但執行工具的 context 帶不同 `ctx.cwd`（orchestrator 多工作目錄、child session 切目錄），**0.84.4 行為 = 固定 A、0.85.1 行為 = 以每次呼叫的 ctx.cwd 為準**。依賴舊固定行為的路徑解析會改變。這是修 bug，但對刻意依賴舊行為的程式碼是行為斷裂。

### 3.2 triggerTurn:false ordering fix — **已於 0.84.4 出貨，非本次升級的新變化**

該修復（「extension messages sent with `triggerTurn: false` while the agent is running being inserted between a tool call and its result, which made providers that validate message order reject the replayed history. They are now appended once the turn's tool results are in」，issue #8537）位於 CHANGELOG **`## [0.84.4]` 段落**（實測行號 101）。0.84.4 的 embedder 已具備此行為；0.85.x 對此無進一步變更。0.84.4 同段還有：RPC `clear_queue`、compaction/branch summary 不再強制 `toolChoice:"none"`、大 tool result 跨 compaction 閾值時在工具執行與下個 assistant 回應之間壓縮（#6879）、`sendMessage(..., {triggerTurn:false})` 不再 steer 活動 run（#8022）。

### 3.3 Session fork / branch summary（0.85.0 Fixed）

- 「Fixed session forks losing their compaction boundary」(#8990) — fork 後 compaction 邊界保留，**恢復 fork 的 context 計算會改變**（修復前可能把已壓縮內容重送）。
- 「Fixed in-memory session forks before an active turn settled」(#8937) — inMemory session 在 turn 未結算時 fork 不再損壞。
- 「Fixed branch summaries failing when reasoning consumes the previous 2048-token output cap」(#8845) — `BranchSummaryConfig` 註釋從「Tokens reserved for prompt + LLM response (default 16384)」改為「Tokens reserved when selecting branch history (default 16384)」；配合 `fromId: string | null` 放寬。
- 0.85.0 另有：「Fixed concurrent session shares overwriting one another」(#8613)、「Fixed imported sessions overwriting an existing session with the same filename」(#8985)。
- `AgentSession.isIdle()` 註釋變寬：「no active agent run, retry, auto-compaction, or queued continuation」→「no active agent run, compaction, branch summary, retry, or queued continuation」（語義：branch summary 進行中也算 busy）。

### 3.4 Write tool 輸出（#8979）：「Fixed the write tool reporting UTF-16 code-unit counts as byte counts by removing the misleading count」— **write 工具結果不再含位元組計數欄位**；若有測試斷言該文字會失敗。

### 3.5 Embedded working indicator（#8799，0.85.0 Changed）

「Moved the streaming working indicator into the default editor border and matched its default spinner and label to the thinking-level border color. Custom editors retain the standalone indicator unless they opt in to embedding it.」— 預設 editor 的 UI 輸出改變；自訂 editor 行為不變（除非傳 `embedWorkingStatus`）。

### 3.6 `pi.setModel` / `pi.setThinkingLevel` 文檔語義收緊（extensions.md diff）

- `pi.setModel`：「Set the current model」→「Set the model for the current session. **The change is recorded in session history and restored when that session is resumed**, but it does not change the configured `defaultProvider` or `defaultModel` used by new sessions.」
- `pi.thinkingLevel`：從「Get or set the thinking level」變為純「Get」+ 獨立的 `pi.setThinkingLevel()` 條目（「changes the thinking level for the current session. The change is recorded in session history and restored when that session is resumed」）。d.ts 簽名未變（`thinkingLevel` getter + `setThinkingLevel` 方法在 0.84.4 已存在），是**文檔對齊**而非 API 變更 — 但「模型/思考等級變更寫入 session history 並在 resume 時還原」的語義被明確化。

### 3.7 Provider/串流行為（pi-ai 層，inherited fixes）

「Fixed inherited provider streams emitting incompatible event sequences and custom tool-call deltas」、「Fixed inherited OpenAI-compatible streams serializing thinking signatures repeatedly during streaming」（0.84.4 段）、OpenAI Codex SSE 終端事件解析（#9047）、Copilot Claude Fable 5 改走 Anthropic Messages adapter（#8961）、`NO_PROXY` root domain/subdomain 匹配（#8737）、proxied plain-HTTP 改 CONNECT tunnel（#8134）、Vertex `HttpsProxyAgent is not a constructor`（#8610）。若 embedder 自己消費 `AssistantMessageEventStream` 事件序，0.85.x 的「標準化事件序」修復可能改變邊角事件順序。

---

## 4. 子套件變更（傳遞依賴，隨 `^0.85.1` 拉入）

| 套件 | 0.85.0/0.85.1 要點 |
|---|---|
| **pi-ai** 0.85.0 | **BREAKING**：「Replaced `createGatewayBindingFetch()` with `createAiBindingFetch()` for Cloudflare Workers AI bindings」（#8287）。新增 `vllmPriority`、`supportsMaxOutputTokens`、per-turn effort、frames API、`uuidv7(ts?)`、`./api/*`/`./providers/*`/`./utils/*` subpath exports（0.85.1 package.json 實測含 `./api/*`, `./oauth`, `./compat`, `./utils/*`, `./bun-oauth`, `./providers/*`, `./bedrock-provider`）。0.85.1：GPT-6 Astra + prompt_cache_options fix。 |
| **pi-tui** 0.85.0 | **BREAKING**：「Removed coding-agent environment-variable defaults from pi-tui. Applications must configure the hardware cursor and clear-on-shrink behavior through the renderer constructor and `setClearOnShrink()`. `PI_DEBUG_REDRAW` is now `PI_TUI_DEBUG_REDRAW`; debug and crash log filenames now use the `pi-tui-` prefix. When no log directory is supplied, redraw logging is disabled and crash dumps are written to the OS temp directory.」（#8699）。Added：`scrollToEndIndicator`、LaTeX join symbols（#9050）。0.85.1：Alt 滾輪加速、hover 不再改選取。 |
| **pi-agent-core** 0.85.0 | 僅 Fixed：「proxied assistant responses dropping persisted provider-native thinking levels」、write tool UTF-16 計數。**無新事件、無 API 增刪**。 |
| **pi-client / pi-protocol** | 0.85.0/0.85.1 changelog 空段落（無變更），但**從 pi-coding-agent 0.85.1 的 dependencies 移除**（source-only client 不再需要）。 |
| **chord**（新） | 0.85.1 deps 首次出現；examples/README 新增 `plugins/pi-example-plugin/`：「An experimental plugin package that Pi automatically builds into separate Session-worker and TUI Chord facets」— 未來 multi-session orchestration 的實驗基座，目前對 SDK 消費者無公開面。 |

---

## 5. 棄用（Deprecations）

**兩版 CHANGELOG 均無任何 `### Deprecated` 段落或 "deprecated" 標記**。最接近的訊號：`./client` subpath 從「supported-looking entry」（0.84.4 runtime 匯入）降級為 source-only（0.85.1）— 實質上是移除而非棄用（無過渡期）；pi-ai 的 `createGatewayBindingFetch` 直接替換無棄用期；pi-tui 的 `PI_DEBUG_REDRAW` 直接改名。這個 repo 的作風是 minor 內直接換、不發棄用警告。

---

## 6. 主要 URL

- CHANGELOG（coding-agent）: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md
- Releases: https://github.com/earendil-works/pi/releases/tag/v0.85.0 · https://github.com/earendil-works/pi/releases/tag/v0.85.1
- SDK docs（#session-management、#events）: repo `docs/sdk.md`（tarball 內同步）
- inMemory entries PR: https://github.com/earendil-works/pi/pull/8980 · ctx.cwd PR: https://github.com/earendil-works/pi/pull/8627 · subpath 修復 issue: https://github.com/earendil-works/pi/issues/9132 · effort/branch-summary: #8845 · fork 邊界: #8990 · inMemory fork: #8937 · triggerTurn: https://github.com/earendil-works/pi/issues/8537 · vllmPriority: #9004 · supportsMaxOutputTokens: #8941 · embedded indicator: #8799 · jump-to-latest: #9080 · prompt-cache/models.md: `docs/models.md#model-configuration`
- npm: https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/0.85.1

---

## RISK LIST（0.84.4 → 0.85.1 對 library embedder 的破壞風險，按可能性排序）

1. **`@earendil-works/pi-coding-agent/client` subpath 匯入直接炸**（幾乎確定壞，若你有用）：exports 只剩 `"source"` 條件、tarball 無對應檔案 → `ERR_PACKAGE_PATH_NOT_EXPORTED`。`./experimental/plugin` 同理（此路徑 0.84.4 根本不存在，僅 0.85.0 短暫存在過）。若 220 symbols 全部來自 root `.`，則不受影響。
2. **工具 `ctx.cwd` 語義反轉**（高，若你的執行環境 ctx.cwd ≠ 工具建構 cwd）：七個內建工具從「固定建構時 cwd」變成「per-call `ctx?.cwd || cwd`」。多目錄 orchestrator/child-session 場景的路徑解析與 bash 工作目錄會實際改變。
3. **傳遞依賴盤點/打包失敗**（中高）：`@earendil-works/pi-client`、`pi-protocol` 自 deps 消失、`@earendil-works/chord` 新增。lockfile 重算、嚴格 license 盤點、或任何 `require.resolve` 這些套件的程式碼會壞。
4. **自訂 OpenAI 相容 provider 的 prompt-cache 請求體變化**（中，若 model 設 `supportsExplicitPromptCacheMode` 或是 GPT-5.6+ Responses）：改送 `prompt_cache_options: {ttl:"30m"}`（不再 `prompt_cache_retention:"24h"`）。嚴格白名單 proxy/網關會拒絕未知欄位。
5. **pi-tui 直接使用者**（中，僅當你繞過 pi-coding-agent 直接 import pi-tui 符號）：env-defaults 移除（hardware cursor / clear-on-shrink 需顯式設定）、`PI_DEBUG_REDRAW`→`PI_TUI_DEBUG_REDRAW`、log 檔名前綴 `pi-tui-`。經 pi-coding-agent 包裝使用則由其內部配置，不受影響。
6. **Theme key 類別移動**（中低，若你做 exhaustive `ThemeBg` map）：`scrollbarThumb` 從 `ThemeBg` 移到 `ThemeColor`（新增 `scrollbarTrack` 也挂 Color）。TS exhaustive map 會缺 key；runtime 主題 JSON 用到該 key 的歸類也變。
7. **pi-ai API 替換**（低-中，僅當直接用 pi-ai）：`createGatewayBindingFetch()` → `createAiBindingFetch()`（Cloudflare Workers AI）。pi-ai 新 subpath exports 為純新增，非風險。
8. **write 工具結果不再報位元組數**（低，但測試斷言會炸）：UTF-16 計數欄位整個移除。
9. **預設 editor UI 輸出變化**（低）：working indicator 移入 editor border — 自訂 editor 不變；快照測試/截圖測試會壞。
10. **事件序列微調**（低）：pi-ai「standard stream events + custom tool-call deltas」標準化、`isIdle()` 現在把 branch summary 視為 busy、`BranchSummaryMessage.fromId` 可為 `null`（型別放寬，但 strict null 檢查下消費端需容 null）。
11. **`AgentSessionEvent` 型別去重**（極低）：重複的 `auto_retry_end` 宣告移除，runtime 事件不變；僅當你對 union 做了奇怪的型別算術才可能受影響。

**明確不受影響**：root `index.d.ts` 匯出面（零刪除，僅 +`CustomEditorOptions`）、`createAgentSession`/`AgentSession`/`SessionManager` 既有方法簽名、stdio RPC API（`./rpc-entry`，官方明言 unchanged）、`triggerTurn:false` ordering（0.84.4 已修）、`SessionManager.inMemory()` 兩參舊呼叫。
