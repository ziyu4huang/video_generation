# Spec: 把 subagent 子系統從 pi-agent-ext-workflow 抽成獨立套件 pi-agent-ext-subagent

## Problem Statement

`pi-agent-ext-workflow` 目前是一個大型套件，同時包含：(a) 整個 workflow orchestration DSL（`parallel`/`pipeline`/`agent()`、`workflow` 工具、TUI、pack 系統、deep-research、adversarial-review），以及 (b) subagent 子系統（程式化派發 `spawnSubagent`、`WorkflowAgent` runner、`subagent`/`subagent_runs` LLM 工具、in-flight 追蹤、run 持久化）。

跨套件唯一實際引用 subagent 能力的是 `pi-agent-ext-knowledge-card`（其 `zk_card`/`zk_ask` 透過 `import { spawnSubagent } from "@repo/pi-agent-ext-workflow"` 派發隔離子代理）。但因為綁在 workflow 套件裡，knowledge-card 被迫拉入整個 workflow 引擎的程式碼面與 runtime 依賴（`acorn` 等）。

**目標**：把 subagent 子系統抽成獨立、少依賴的底層套件 `pi-agent-ext-subagent`，並讓它**自帶 pi extension**（註冊 `subagent` + `subagent_runs` 工具），使 subagent 能力可脫離 workflow DSL 獨立載入；knowledge-card 改依賴這個輕量套件。

## Solution

兩個套件、單向依賴：

```
pi-agent-ext-subagent   (下層 — 擁有 subagent 引擎 + 工具 + 資料層)
    ▲
    │  import @repo/pi-agent-ext-subagent
    │
pi-agent-ext-workflow    (上層 — 保留 workflow DSL + TUI glue)
```

- `pi-agent-ext-subagent`（新）擁有：`spawnSubagent`、`WorkflowAgent` runner、`subagent`/`subagent_runs` 工具、in-flight registry、run-persistence、git-scope、worktree、model-tier、structured-output、agent-registry、errors、agent-history、sdd-report、config(部分)、home。透過 `extensions/subagent.ts` 註冊兩個工具。
- `pi-agent-ext-workflow`（重構）保留：整個 workflow DSL、所有 `workflow*` 工具/TUI/manager/pack/editor、`display`、`task-panel`、以及兩個 subagent TUI 檔（`subagent-viewer`、`subagents-command`）。改為從新套件 import subagent 引擎。

## The Seam — 為何 viewer/command 必須留在 workflow

「整個 subagent 子系統」大約 95% 可乾淨搬移，但 **`subagent-viewer.ts` 與 `subagents-command.ts` 必須留在 workflow**：

- `subagent-viewer.ts` 匯入 `display.ts` 的 `renderActivityRow` / `ActivityRow`。
- `display.ts` 反向匯入 `workflow.ts`（使用 `WorkflowMeta`、`WorkflowAgentStatus`、`shortModel`、`fmtTokensShort`、`ThemeLike` 等 display 內部函式）。
- 若 viewer 搬進新套件，會形成循環：`subagent → display → workflow → subagent`（workflow 依賴 subagent 的 runner）。
- `renderActivityRow` 與 display 內部焊接太深（共用 `WorkflowAgentStatus`、多個本地 helper），抽出會在 display.ts 鑿出大洞，不符成本。

**結論**：viewer 與 `/subagents` command 是 TUI 呈現/composition，本質屬 workflow；其餘 subagent 引擎全部搬走。已驗證 16 個搬移模組**沒有任何** `./workflow*` 匯入，無循環。

## Module Manifest

### 搬移到 `pi-agent-ext-subagent/src/`（16 個模組）

引擎 / runner：
- `spawn-subagent.ts` — 公開函式 `spawnSubagent` + `SpawnSubagentOptions`/`SpawnSubagentResult`/`SpawnSubagentPrime`
- `agent.ts` — `WorkflowAgent`、`AgentUsage`、`BudgetExhaustion`、`listAvailableModelSpecs`、`AgentRunOptions`/`AgentRunResult`/`WorkflowAgentOptions`
- `agent-history.ts` — `compactAgentHistory`、`summarizeLatestAction`、`AgentHistoryEntry` 系列
- `agent-registry.ts` — `applyToolPolicy`、`listAgentTypes`、`loadAgentRegistry`、`resolveAgentType`
- `errors.ts` — `WorkflowError`、`WorkflowErrorCode`、`classifyProviderLimit`、`isWorkflowError` 等
- `model-tier-config.ts` — `loadModelTierConfig`、`resolveTierModel`、`sortedTierNames`、`buildDefaultTierConfig` 等
- `sdd-report.ts` — `parseSddReport`、`isSddReportActionable`、`SDD_REPORT_STATUSES`
- `structured-output.ts` — `createStructuredOutputTool`、`StructuredOutputCapture`

資料層 / 工具：
- `subagent-tool.ts` — `createSubagentTool`、`SubagentToolDetails`
- `subagent-runs-tool.ts` — `createSubagentRunsTool`、`SubagentRunsToolOptions`
- `subagent-run-persistence.ts` — `createSubagentRunPersistence`、`generateSubagentRunId`、`subagentHomeDir`、`subagentRunsDir`、常數
- `subagent-in-flight.ts` — `SubagentInFlightRegistry`、`InFlightSubagent`

共用葉節點：
- `git-scope.ts`（零內部依賴）
- `worktree.ts`（零內部依賴；目前 `workflow.ts` 與 `subagent-tool.ts` 都用，搬移後 workflow 從新套件 import）
- `home.ts`（`homeDir`；整個搬，workflow 從新套件 import）
- `config.ts`（**拆分**：只搬 `MODEL_TIERS_FILE` + `AGENTS_DIR`——這是搬移模組（`agent-registry`/`model-tier-config`）實際引用的 config 符號；其餘 `WORKFLOW_*` 常數、`DEFAULT_AGENT_TIMEOUT_MS`/`MAX_AGENT_*`、`normalizeKeywordTriggerWord` 等留 workflow 的 config.ts）

> 已 grep 驗證：**沒有任何留存檔案**引用 `MODEL_TIERS_FILE`/`AGENTS_DIR`（留存檔案只用 `WORKFLOW_*`/`MAX_AGENT_*`/`DEFAULT_*`/`normalizeKeywordTriggerWord`，全數留在 workflow config.ts）。故 config 拆分對留存檔案**零影響**——它們繼續用本地 config.ts，不需改寫。Plan 階段仍以 grep 復核。

### 留在 `pi-agent-ext-workflow/src/`

- TUI glue：`subagent-viewer.ts`、`subagents-command.ts`、`display.ts`、`task-panel.ts`、`workflow-ui.ts`
- 整個 workflow DSL：`workflow.ts`、`workflow-tool.ts`、`workflow-control-tool.ts`、`workflow-manager.ts`、`workflow-pack*.ts`、`workflow-editor.ts`、`workflow-commands.ts`、`workflow-settings.ts`、`workflow-saved.ts`、`workflow-paths.ts`
- 其他：`run-persistence.ts`、`host-fn-helpers.ts`、`host-fn-registry.ts`、`call-global.ts`、`builtin-commands.ts`、`saved-commands.ts`、`model-routing.ts`、`logger.ts`、`effort-command.ts`、`adversarial-review.ts`、`deep-research.ts`、`workflows-models-command.ts`、`pack-run-context.ts`、`pack-state.ts`、`web-tools.ts`

## Architecture — Extension Wiring（Design B）

### 新 extension 進入點 `pi-agent-ext-subagent/extensions/subagent.ts`

依 CLAUDE.md 命名規則（`extensions/<X>.ts`，`<X>` = 資料夾去掉 `pi-agent-ext-`）。

職責：
1. `session_start` 自行捕獲（不靠 workflow 的閉包）：
   - parent-session 工具定義：`(pi as ...).getAllToolDefinitions?.()` → 存入套件內 `extensionToolsHolder`。
   - 主模型：`ctx.model` → `${ctx.model.provider}/${ctx.model.id}` → 存入套件內 `mainModelHolder`。
2. 取／建立套件單例：`getSubagentInFlightRegistry()`、`getSubagentRunPersistence()`。
3. 建立 `createSubagentTool({ cwd, getExtensionTools, getMainModel, inFlight, persistence })` + `createSubagentRunsTool({ persistence })`，`pi.registerTool(...)` 兩者。
4. 保留對 `'subagent'` 工具名已被註冊的 load-order 警告（best-effort）。

### 套件單例（跨 extension 共享的唯一狀態）

`subagent-in-flight.ts` 與 `subagent-run-persistence.ts` 各新增一個 module-level 單例 accessor：

```ts
// subagent-in-flight.ts
let _registry: SubagentInFlightRegistry | undefined;
export function getSubagentInFlightRegistry(): SubagentInFlightRegistry {
  return (_registry ??= new SubagentInFlightRegistry());
}
// subagent-run-persistence.ts
let _persistence: ReturnType<typeof createSubagentRunPersistence> | undefined;
export function getSubagentRunPersistence() {
  return (_persistence ??= createSubagentRunPersistence());
}
```

- `SubagentInFlightRegistry` 類別與 `createSubagentRunPersistence` 工廠**繼續匯出**（測試注入用，符合現有 `createSubagentTool({ inFlight })` 注入模式）；單例只是 production 預設。
- 兩個 extension（subagent 寫入、workflow 的 viewer/command 讀取）一致以 `@repo/pi-agent-ext-subagent` workspace 匯入 → 同一 module instance → 同一單例。

### `pi-agent-ext-workflow/extensions/workflow.ts` 對應改動

- **移除**：`new SubagentInFlightRegistry()`、`createSubagentRunPersistence()`、`createSubagentTool(...)`、`createSubagentRunsTool(...)` 的建立與 `pi.registerTool(subagentTool/subagentRunsTool)`、`'subagent'` load-order 警告、`pi.registerCommand("subagents", ...)` 中對 registry 實例的直接持有。
- **改用單例**：`const subagentInFlight = getSubagentInFlightRegistry();`、`const subagentPersistence = getSubagentRunPersistence();`（供 `/subagents` command、viewer、result-delivery 讀取）。
- `pi.registerCommand("subagents", createSubagentsCommand({ subagentInFlight }))` 保留（command 實作留在 workflow）。
- workflow 自有的 `extensionToolsHolder` 保留（供 `WorkflowManager.setExtensionTools` 與 workflow runs 使用）；subagent 工具改用 subagent 套件自有的 holder，**兩者獨立、不共享**。

### Static extension 註冊

`pi-agent/src/static-extensions.ts`：在 workflow 之前加入 subagent extension（always-on，與 workflow 同層 always-on）。依 CLAUDE.md，加入 `static-extensions.ts` 即自動被 schema-cost canary（`pi-agent-cli/src/commands/schema-cost.ts`）測量，無需手動 `EXTRA_ENTRIES`。

## Cross-Package Import Rewrites

改寫分三類：

### A. 符號保留改寫（`./xxx.js` → `from "@repo/pi-agent-ext-subagent"`，符號不變）

| workflow 留存檔 | 改寫的匯入來源 |
|---|---|
| `src/workflow.ts` | `agent`, `agent-history`, `agent-registry`, `errors`, `sdd-report`, `worktree` |
| `src/workflow-pack.ts` | `agent` |
| `src/workflow-manager.ts` | `agent`, `errors` |
| `src/workflow-tool.ts` | `agent`, `agent-registry`, `errors` |
| `src/workflows-models-command.ts` | `agent`, `model-tier-config` |
| `src/run-persistence.ts` | `agent-history`, `errors` |
| `src/host-fn-helpers.ts` | `errors` |
| `src/display.ts` | `agent-history`, `errors` |
| `src/call-global.ts` | `errors` |
| `src/task-panel.ts` | `agent-history` |
| `src/workflow-ui.ts` | `agent-history` |
| `src/workflow-paths.ts` | `home` |
| `src/subagent-viewer.ts` | `agent`, `agent-history`, `subagent-in-flight`, `subagent-tool`（`display` 留同套件） |
| `src/subagents-command.ts` | `subagent-in-flight`（`subagent-viewer` 留同套件） |

### B. `extensions/workflow.ts` 結構改動（非單純路徑改寫）

已驗證此檔只透過 `../src/` 引用 4 個搬移符號，改動如下：
- **移除** `createSubagentTool` / `createSubagentRunsTool` 的 import、建立式與 `pi.registerTool(...)`（改由 subagent extension 擁有）。
- `new SubagentInFlightRegistry()` → `getSubagentInFlightRegistry()`（from 新套件，供 `/subagents` command 與 viewer 讀取）。
- `createSubagentRunPersistence()` → `getSubagentRunPersistence()`（from 新套件）。
- 移除 `'subagent'` load-order 警告（隨工具註冊遷移到 subagent extension）。
- 其餘 `../src/` workflow import 與 `pi.registerCommand("subagents", ...)` 不變。

### C. 零改動的留存檔案

- `src/workflow-settings.ts`、`src/workflow-editor.ts`：只引用本地 config 常數（`MAX_AGENT_*`/`normalizeKeywordTriggerWord`/`DEFAULT_KEYWORD_TRIGGER_WORD`），不觸及任何搬移模組——零改動。
- 所有留存檔案對 `config` 的引用皆保留本地（config 拆分不影響留存檔案）。

### D. `src/index.ts` re-export

改為 **re-export** 所有搬移符號 `from "@repo/pi-agent-ext-subagent"`（向後相容；見〈Backward Compatibility〉）。

> Plan 階段以 `grep -rn 'from "\./' src/ extensions/` 對照搬移清單產生完整改寫清單，確保無遺漏。

## Consumer Migration — knowledge-card

`pi-agent-ext-knowledge-card`：
- `extensions/knowledge-card.ts`：`from "@repo/pi-agent-ext-workflow"` → `from "@repo/pi-agent-ext-subagent"`（只引 `spawnSubagent` + 型別）。
- `package.json`：依賴從 `@repo/pi-agent-ext-workflow` 改為 `@repo/pi-agent-ext-subagent`（knowledge-card 只用 `spawnSubagent`，可**完全脫離** workflow 依賴）。

## Backward Compatibility

`pi-agent-ext-workflow/src/index.ts` **re-export** subagent 公開 API（`export { spawnSubagent, type SpawnSubagentOptions, ... , WorkflowAgent, createSubagentTool, ... } from "@repo/pi-agent-ext-subagent"`），讓任何未遷移的消費者繼續 `from "@repo/pi-agent-ext-workflow"` 可用。成本極低（workflow 本就依賴新套件）。

## Dependencies（package.json）

### `pi-agent-ext-subagent`（新）
- `name`: `@repo/pi-agent-ext-subagent`
- `main`/`types`: `./dist/index.js` / `./dist/index.d.ts`（比照 workflow 建 dist）
- `exports`: `.`、`./src/*`、`./extensions/*`（比照 workflow）
- `scripts`: `build`(bunx tsc)、`test`(biome check + build + bun test)、`check`(biome)、`dev`
- **runtime deps = 0**
- `peerDependencies`: `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai`、`typebox`（與 workflow 同版號 `0.82.0`/`*`）
- `devDependencies`: `@biomejs/biome`、`tsx`、`typescript`、`@types/bun`、+ 同 peer（比照 workflow devDeps）
- `pi.extensions`: `["extensions/subagent.ts"]`
- `keywords`: `pi-package`, `pi`, `subagents`, `multi-agent`, `ai-agents` 等

> 誠實揭露：`subagent-tool.ts` 使用 `pi-tui`（`Text`、`truncateToWidth`）做結果渲染，故新套件仍 peerDep `pi-tui`。本抽件的**實質「少依賴」收益**是：消費者（knowledge-card）不再拉入 workflow 引擎的程式碼面與 workflow 專屬 runtime 依賴（`acorn`）；新套件 runtime deps 為 0。

### `pi-agent-ext-workflow`（重構）
- `dependencies` 新增 `"@repo/pi-agent-ext-subagent": "workspace:*"`。
- 保留 `acorn`（workflow.ts 解析 orchestration script 用，屬 workflow）。
- 其餘 peer/dev 不變。

## Risks & Mitigations

1. **跨 extension 單例一致性** — 兩 extension 必須一致用 `@repo/pi-agent-ext-subagent` workspace 匯入（不可用 `../../src/...` 相對路徑），確保 module identity → 同一 registry/persistence 實例。`pi-agent/src/patches/ensure-extension-deps.ts` 已強制 `@repo/<pkg>` bare specifier 慣例，為既有保障。
2. **Build 一致性** — 新套件須 `bun run build` 產 `dist/index.js`。比照 `pi-agent-cli/src/__tests__/boot-smoke.test.ts` 的 `buildIfMissing("pi-agent-ext-workflow", ...)` 模式，確保測試前已建置。
3. **Load order** — registry/persistence 單例惰性建立；若 subagent extension 未載入（理論上不會，兩者皆 always-on），viewer 只看到空集合（graceful degrade）。
4. **向後相容破壞** — workflow `index.ts` re-export 涵蓋所有原本公開符號；Plan 階段比對原 `index.ts` 匯出清單逐一 re-export，不可漏。
5. **config 拆分遺漏** — Plan 階段 grep 驗證搬移模組對 `config.js` 的匯入符號僅 `MODEL_TIERS_FILE` + `AGENTS_DIR`。
6. **無循環** — 已驗證 16 個搬移模組無 `./workflow*` 匯入；`subagent-viewer → display` 邊保留於 workflow 同套件內，不跨套件。

## Verification

1. `bun install`（於 `bun-apps/`）成功；新套件 `package.json` workspace 連結正確。
2. `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build && bun test )` 全綠。
3. `( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun test )` 全綠——特別是既有 `tests/spawn-subagent.test.ts`、`tests/subagent-tool.test.ts`、`tests/regression-subagent-contract.test.ts`、`tests/subagent-viewer.test.ts`。
4. `( cd bun-apps/pi-agent-ext-knowledge-card && bun test )` 全綠——`zk_*` 仍能透過 `spawnSubagent` 派發。
5. `bun run --cwd bun-apps/pi-agent-cli check:schema`（或等效 schema-cost）通過——確認 static-extensions 新增後 schema 成本符合預期、無重複註冊。
6. 手動/煙霧：`pi` 啟動後 `subagent`、`subagent_runs`、`workflow`、`workflow_control` 工具與 `/subagents` 命令皆可用；`subagent({ task: "t", tools: ["read"] })` 能跑出隔離子代理結果。
7. 跨 extension 單例：`/subagents` 能即時看到 `subagent` 工具觸發的 in-flight run（驗證兩 extension 共用同一 registry 實例）。
8. 無循環：`bun build` / tsc 不報循環依賴；`madge --circular`（若可用）為空。

## Out of Scope

- 搬移 `subagent-viewer.ts` / `subagents-command.ts`（焊接於 `display.ts`，見 The Seam）。
- 把 `subagent` 工具的結果渲染去 `pi-tui` 依賴（YAGNI；超出抽件範圍）。
- 任何 subagent 行為/功能變更——純結構重構，行為位元級不變。
- 改動 `spawnSubagent` 的公開簽名或 `WorkflowAgent.run` 契約。
- 整併或新增 subagent 功能（如 auto-primer「③」）。
- 遷移 workflow 既有其他消費者（CLI `workflow run` 等）——它們繼續用 `@repo/pi-agent-ext-workflow`（re-export 涵蓋）。

## Further Notes

- 方案 A（純函式庫、無 extension、workflow 維持組裝根）列為未來想讓「subagent 工具脫離 workflow」以外的解耦路線圖；本 spec 採使用者選定的方案 B。
- CONTEXT.md：新套件應有自己專屬的 `CONTEXT.md`（ubiquitous language：subagent / spawn / in-flight / run-persistence / agent-registry）；workflow 的 `CONTEXT.md` 把 `spawnSubagent` 條目改為指向新套件。依 `docs/agents/domain.md` 多 context 慣例，於 root `CONTEXT-MAP.md` 補上第二個 context（若尚未有）。
- ADR：建議於 `bun-apps/pi-agent-ext-subagent/docs/adr/0001-why-extracted.md` 記錄「為何抽件、為何 viewer/command 留下、為何選 B」。
