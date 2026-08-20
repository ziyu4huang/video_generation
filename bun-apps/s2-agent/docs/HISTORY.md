# Development History — s2-agent Patches

> 記錄所有 runtime monkey-patch 的動機、解法與演進。
>
> 每個 patch 都註冊在 `src/patches/index.ts` 的 `PATCH_TABLE` 中，
> 透過 env gate 控制啟用，可獨立關閉、可除錯。
>
> 時間軸：從 monorepo 初期基礎建設到 2026-07-18 的 `pre-load-providers` 純化拆分。

---

## 時間軸

```
2026-06-30  ─┬─ index.ts         patch 註冊系統初始化
             ├─ pre-load-providers  客製 provider 載入
             └─ skip-update-check   關閉版號檢查 banner

2026-07-01  ─┬─ set-package-dir     bundle 模式下修正路徑
             └─ skip-update-check   補 commit 記錄

2026-07-02  ─┬─ load-run-dir-resources  extension 絕對路徑解析
             ├─ default-model-env       env → argv 橋接
             └─ index.test              patch 測試完善

2026-07-04  ─── ensure-extension-deps   node_modules symlink

2026-07-05  ─┬─ ext-context-get-system-prompt-options   PR #297
             └─ ext-api-get-all-tool-definitions         PR #297

2026-07-18  ─── pre-load-providers   拆分修復（見 Patch 1 章節）
```

---

## 目錄（依時間排序）

| # | Patch | Created | PR |
|---|---|---|---|
| 1 | `index.ts` — 註冊系統基礎架構 | 2026-06-30 | 初期基礎建設 |
| 2 | `pre-load-providers` | 2026-06-30 | 初期基礎建設 |
| 3 | `skip-update-check` | 2026-06-30 | 初期基礎建設 |
| 4 | `set-package-dir` | 2026-07-01 | 初期基礎建設 |
| 5 | `load-run-dir-resources` | 2026-07-02 | 初期基礎建設 |
| 6 | `default-model-env` | 2026-07-02 | 初期基礎建設 |
| 7 | `ensure-extension-deps` | 2026-07-04 | 初期基礎建設 |
| 8 | `ext-context-get-system-prompt-options` | 2026-07-05 | [#297](https://github.com/ziyu4huang/video_generation/pull/297) |
| 9 | `ext-api-get-all-tool-definitions` | 2026-07-05 | [#297](https://github.com/ziyu4huang/video_generation/pull/297) |

---

## Patch 0: `index.ts` — 註冊系統基礎架構

| 屬性 | 值 |
|---|---|
| **檔案** | `src/patches/index.ts` + `index.test.ts` |
| **Created** | 2026-06-30 |
| **Last updated** | 2026-07-05（加入 patch #8, #9） |
| **PR** | 初期基礎建設 |

### 說明

所有 patch 的註冊中樞。定義 `PATCH_TABLE`（name + env gate + default）、`resolvePatchPlan()`（純函數決策）、`applyPatches()`（執行 side effect）。

新 patch 加入流程：`PatchName` union → `PATCH_TABLE` entry → switch case → 更新測試 expectation。

---

## Patch 1: `pre-load-providers`

| 屬性 | 值 |
|---|---|
| **Env gate** | `BUN_PI_PRE_LOAD_PROVIDERS` (default `true`) |
| **檔案** | `src/patches/pre-load-providers-patch.ts`（實際 monkey-patch）+ `src/pre-load-providers.ts`（純資料/helper，`PROVIDERS` 目錄 + `registerAllProviders()`，無 import-time side effect） |
| **Created** | 2026-06-30 |
| **Last updated** | 2026-07-18 |
| **PR** | 初期基礎建設；2026-07-18 拆分修復（見下方「2026-07-18 修復」段落） |

在 `ModelRegistry` 建構時注入客製 provider（lm-studio, ollama, llamacpp, openrouter 等），不需外部 models.json。

**2026-07-18 修復**：原本 `src/pre-load-providers.ts` 本身在 import 時就會執行 `Proto.loadModels = ...` 這個 monkey-patch（module-scope side effect），導致任何只想拿 `PROVIDERS`/`resolveApiKey` 資料的 consumer（例如 `s2-agent-cli`）一旦 import 就會意外套用這個 patch，造成 provider 重複註冊。修復後，`src/pre-load-providers.ts` 變成純資料模組（無 side effect），實際的 patch 邏輯搬到 `src/patches/pre-load-providers-patch.ts`，只有 `applyPatches()`（env-gated）才會載入它。兩處呼叫端（patch 本身、`s2-agent-cli`）都改用共用的 `registerAllProviders(registry, env)` helper。

---

## Patch 2: `skip-update-check`

| 屬性 | 值 |
|---|---|
| **Env gate** | `BUN_PI_SKIP_UPDATE_CHECK` (default `true`) |
| **檔案** | `src/patches/skip-update-check.ts` |
| **Created** | 2026-06-30 |
| **Last updated** | 2026-07-01 |
| **PR** | 初期基礎建設 |

### 問題

pi 的 `version-check.js` 在啟動時 fetch `https://pi.dev/api/latest-version`，若有新版則印 "Update Available" 提示 `pi update`。對 s2-agent bundle/binary 這是無意義的：
- artifact 是我們自己的 build，不是 upstream npm package
- `pi update` 會更新錯誤的東西（或失敗）
- version string 已經是 `v0.0.0`

### 解法

設定 `PI_SKIP_VERSION_CHECK=1`，讓 `getLatestPiRelease()` 回傳 `undefined`，完全跳過檢查。mode-agnostic（source + bundle + binary 都適用）。

---

## Patch 3: `set-package-dir`

| 屬性 | 值 |
|---|---|
| **Env gate** | `BUN_PI_SET_PACKAGE_DIR` (default `true`) |
| **檔案** | `src/patches/set-package-dir.ts` |
| **Created** | 2026-07-01 |
| **Last updated** | 2026-07-02 |
| **PR** | 初期基礎建設 |

### 問題

pi 的 `getPackageDir()` 有三種有效路徑：
- **binary mode**: `dirname(process.execPath)` — 正確。assets 在 build 時被複製到 exe 旁
- **bundle .js mode**: walk up from `__dirname` 找 `package.json` → 找到 monorepo root → 嘗試 `dist/modes/interactive/theme` 錯誤位置
- **source mode**: 透過真實 node_modules tree 正確解析 — 不需要 override

### 解法

設定 `PI_PACKAGE_DIR` env var，指向 `@earendil-works/pi-coding-agent` 的安裝位置，讓 bundle mode 也能正確載入 theme/template assets。

```typescript
if (mode === "bundle" && PI_PKG_DIR) {
  process.env.PI_PACKAGE_DIR ??= PI_PKG_DIR;
}
```

---

## Patch 4: `load-run-dir-resources`

| 屬性 | 值 |
|---|---|
| **Env gate** | `BUN_PI_LOAD_RUN_DIR` (default `true`) |
| **檔案** | `src/patches/load-run-dir-resources.ts` |
| **Created** | 2026-07-02 |
| **Last updated** | 2026-07-04 |
| **PR** | 初期基礎建設 |

### 問題

pi 的 `main()` 只使用一個 `process.cwd()` 來做所有 project-resource lookup（`.pi/settings.json`, `.pi/extensions`...），沒有 `--cwd` override。這意味著舊的 `.pi/settings.json` "packages" list 只在你從 **repo root** 執行時才有效。絕對路徑的 `-e`/`--skill` 可以 bypass cwd resolution 和 trust-gating。

### 解法

解析 `run-dir/manifest.json` 中定義的 extension/skill 路徑，轉成絕對路徑，splice 進 `process.argv` 讓 `main()` 讀到。

支援三種模式：
- **source mode**: 從 `import.meta.url` 計算 `bun-apps/` 目錄
- **bundle mode**: 讀取 build-time 產生的 `run-dir-base.ts`
- **binary mode**: 無操作

也負責 lazy extension alias 解析（`-e workflow` → 絕對路徑）。

---

## Patch 5: `default-model-env`

| 屬性 | 值 |
|---|---|
| **Env gate** | `BUN_PI_DEFAULT_MODEL_ENV` (default `true`) |
| **檔案** | `src/patches/default-model-env.ts` |
| **Created** | 2026-07-02 |
| **Last updated** | 2026-07-02 |
| **PR** | 初期基礎建設 |

### 問題

真實的 pi TUI 只從 `~/.pi/agent/settings.json` 讀取 default model/provider，不認 `PI_MODEL` / `PI_PROVIDER` / `PI_THINKING` 環境變數。s2-agent-cli 有吃這些 env var，但 s2-agent（wrapper）會忽略它們。

### 解法

當 user 沒有傳入對應的 CLI flag 時，把 env value splice 進 `process.argv` 讓 pi 收到。

```typescript
const extra = resolveEnvBridges(process.argv);
if (extra.length) {
  process.argv.splice(2, 0, ...extra);
}
```

`resolveEnvBridges()` 是純函數，完整 unit test 覆蓋。

---

## Patch 6: `ensure-extension-deps`

| 屬性 | 值 |
|---|---|
| **Env gate** | `BUN_PI_ENSURE_EXT_DEPS` (default `true`) |
| **檔案** | `src/patches/ensure-extension-deps.ts` |
| **Created** | 2026-07-04 |
| **Last updated** | 2026-07-04 |
| **PR** | 初期基礎建設 |

### 問題

pi 載入每個 extension 時，jiti 先嘗試 `try-native`（Bun 直接 import .ts），但因為 extension 的 bare specifiers（`@earendil-works/*`, `typebox`）不在 walk-up path 上，`try-native` 失敗。jiti 退而 transform 每個 module，但在 Bun + jiti 2.7.0 下任何 >4KB 的 module 都會觸發 temp-file bug：

```
Cannot find module .../jiti-esm/binary-*.mjs from ''
```

所有 >4KB 的 extension（`s2-agent-ext-flux2`, `pi-hermes-memory` 等）都無法載入。

### 解法

在 repo root 建立 `node_modules/` symlinks 指向 global store 中同一個 package，讓 `try-native` 成功：

```typescript
const targets = {
  "@earendil-works/pi-coding-agent": pkgRoot("..."),
  "@earendil-works/pi-agent-core": pkgRoot("..."),
  "@earendil-works/pi-ai": pkgRoot("..."),
  typebox: pkgRoot("typebox"),
};
```

---

## Patch 7: `ext-context-get-system-prompt-options`

| 屬性 | 值 |
|---|---|
| **Env gate** | `BUN_PI_EXT_CTX_GET_SYSTEM_PROMPT_OPTIONS` (default `true`) |
| **檔案** | `src/patches/ext-context-get-system-prompt-options.ts` |
| **Created** | 2026-07-05 |
| **Last updated** | 2026-07-05 |
| **PR** | [#297](https://github.com/ziyu4huang/video_generation/pull/297) |

### 問題

`@earendil-works/pi-coding-agent 0.80.3` 把 `getSystemPromptOptions()` 加在了 `ExtensionCommandContext`（只有 command handler 能用），但 **沒有** 加在 base `ExtensionContext`。我們的 extension tools（`context_analyzer`, `agent_inventory`, `extension_analyzer`）在 `execute()` callback 中收到的是 `ExtensionContext`，不是 `ExtensionCommandContext`。

最初的 fix 是直接改 bun cache 的 compiled JS — 但 `bun install` 後就會消失。

### 解法

Monkey-patch `ExtensionRunner.prototype.createContext()`，在回傳的 context object 中加入 `getSystemPromptOptions` 方法：

```typescript
// 原本 createContext() 回傳：
{ ...getSystemPrompt, ...otherMethods }
// patch 後：
{ ...getSystemPrompt, getSystemPromptOptions, ...otherMethods }
```

因為 `createCommandContext()` 透過 `Object.defineProperties` 繼承自 `createContext()`，所以 command context 自動拿到此方法。

**測試：** 17 patches tests pass，包含整合測試 `applyPatches()` 確認新 patch 載入無誤。

---

## Patch 8: `ext-api-get-all-tool-definitions`

| 屬性 | 值 |
|---|---|
| **Env gate** | `BUN_PI_EXT_API_GET_ALL_TOOL_DEFS` (default `true`) |
| **檔案** | `src/patches/ext-api-get-all-tool-definitions.ts` |
| **Created** | 2026-07-05 |
| **Last updated** | 2026-07-05 |
| **PR** | [#297](https://github.com/ziyu4huang/video_generation/pull/297) |

### 問題

`ExtensionAPI.getAllTools()` 回傳 `ToolInfo[]` — `Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines">`，**故意省略 `execute`**。

`WorkflowAgent.run()` 需要完整 `ToolDefinition[]` 才能傳給 `createAgentSession({ customTools })`，讓 workflow subagent 可以呼叫 parent session 的 extension tools。

`ExtensionRunner.getAllRegisteredTools()` 已經有完整資料（`RegisteredTool[].definition` 就是完整 `ToolDefinition`）— 但沒有暴露在 `ExtensionAPI` 上。

### 解法

Monkey-patch `ExtensionRunner.prototype.bindCore()`，在執行完原始邏輯後額外設定：

```typescript
this.runtime.getAllToolDefinitions = () =>
  this.getAllRegisteredTools().map(t => t.definition);
```

workflow extension 在 `session_start` handler 中收集：

```typescript
const extTools = (pi as any).getAllToolDefinitions?.();
if (extTools?.length) {
  manager.setExtensionTools(extTools);
}
```

### 測試

6 個 unit test 驗證純函數邏輯，加上整合測試確認 patch 載入。

---

## 如何新增一個 Patch

1. 在 `src/patches/` 下建立 `<name>.ts`
2. 在檔案 header comment 中註明 `Created` 日期與 `PR`
3. 在 `src/patches/index.ts` 中：
   - `PatchName` union 加入新名稱
   - `PATCH_TABLE` 加入 entry（含 env gate）
   - `applyPatches()` switch 加入 case
4. 更新 `src/patches/index.test.ts` 的已知 patches list
5. 更新此文件 `docs/HISTORY.md`：
   - 時間軸加入新 patch
   - 目錄表加入新行
   - 新增對應的 patch 章節

### env gate 慣例

```
BUN_PI_<PATCH_NAME_UPPER> = 0    → 關閉此 patch
BUN_PI_DEBUG_PATCHES = 1         → 開啟所有 patch 的除錯輸出
```
