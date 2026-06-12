# Bun GUI 模組化重構 — 解耦 view 與統一 schema

## Context

`bun/gui-movie-director/` 是個正在使用中的 Bun + React SPA，呼叫 `python/mlx-movie-director/run.py`。
大多數 view 本質獨立（只是把表單參數送到 `/api/run` 跑對應指令），但目前有三個「共用 chokepoint」
使得「改一個 view 不影響其他、可安心並行修改」做不到：

1. **`frontend/app.tsx` 中央註冊**：新增/修改一個 view 必須同時改三處共用區塊 —
   `import`、`COMMAND_GROUPS`、`VIEW_MAP`。多人/多任務改不同 view 都會在 app.tsx 撞同一檔。
2. **雙 schema 系統手動同步**：`lib/schemas/<cmd>.ts`(CLI flag) 與 `frontend/schemas/<cmd>.ts`(UI 表單)
   是兩套各寫一份、靠人工對齊 key。以 controlnet 為例，兩檔的 `controlnet_type` choices/default 完全重複，
   加一個欄位要改兩處且容易漏 → 最大的隱性 bug 來源。
3. **全域 `styles.css`(1536 行) 無 scope**：任何樣式調整都在同一全域命名空間，view 之間樣式會互相干擾。

已經乾淨的部分（不動）：16 個 view 是 3 行的 `createCommandView(schema)`；per-view hooks 是 per-instance；
view 之間互不 import；後端 `lib/args.ts`、`api/jobs.ts` 的 `/api/run` 流程穩定。

**使用者決策**：留在 Bun.build（不引入 Vite）、schema 統一成單一 source of truth、
per-view scoped CSS Modules、**分階段（先結構、後 CSS/build）**。

**目標成果**：新增一個指令只改「自己的 view 檔 + 一個 registry 條目」，schema 只寫一份，
樣式 scoped 到自己的 view，彼此可安心並行修改。

---

## 目標架構（Bun.build 保留，漸進落地）

四個 Phase 各自可獨立 ship 並用 `bun run dev` 驗證。Phase 1–3 是結構解耦，Phase 4 是 CSS/build 變更。

### ✅ Phase 1 — 單一來源 View Registry [done 2026-06-12 bundle 1185KB OK]

把「import + COMMAND_GROUPS + VIEW_MAP」三處共用編輯收斂成「每個 view 自帶 descriptor + 一個 registry barrel」。

- 新增 `frontend/views/registry.ts`：
  ```ts
  import type { ComponentType } from "react";
  export interface ViewDescriptor {
    id: string; group: string; label: string; icon: string;
    component: ComponentType;
  }
  export const GROUP_ORDER = ["Generate","Workflow","Transform","Edit","Analyze","Tools"];
  ```
- 每個 view 檔**就地匯出自己的 descriptor**（metadata 與元件同住一處），例如
  `frontend/views/generate/T2iView.tsx`：
  ```ts
  export const t2iView: ViewDescriptor = {
    id: "t2i", group: "Generate", label: "Text → Image", icon: "🎨",
    component: createCommandView(T2I_SCHEMA),
  };
  ```
- 新增 `frontend/views/index.ts`（唯一的清單檔）：import 各 view descriptor，push 進 `export const VIEWS: ViewDescriptor[]`。
- `frontend/app.tsx` 改成**從 `VIEWS` 衍生** `COMMAND_GROUPS`（依 `GROUP_ORDER` 分組）與 `VIEW_MAP`（id→component），
  刪除手寫的 import 區與兩個 map。app.tsx 之後新增 view 完全不需再動。
- 對外保持相容：`COMMAND_GROUPS` / `ALL_COMMANDS` 仍由 app.tsx export（`Layout.tsx` 等沿用）。

**結果**：新增 view = 建 `FooView.tsx`（含 descriptor）+ 在 `views/index.ts` 加一行。Gallery/Config/Jobs 三個非指令 view 維持 app.tsx 特例。

關鍵檔：`frontend/views/registry.ts`(新)、`frontend/views/index.ts`(新)、`frontend/app.tsx`、各 `frontend/views/**/*.tsx`(加 descriptor export)。

### ✅ Phase 2 — 統一 Command Schema [done 2026-06-12 frontend 1.22MB + server 1.00MB OK]

每個指令只寫一份 schema，同時描述 CLI 與 UI；`lib`(server) 與 frontend 都由它衍生。

- 新增中性目錄 `schemas/`（gui 根層，server 與 frontend 都能 import；皆為純資料、無 node/Bun 依賴）。
- 定義統一型別 `schemas/types.ts` — 每個欄位同時帶 CLI 與 UI 資訊：
  ```ts
  interface UnifiedField {
    key: string;
    cliFlag: string;                         // CLI 端
    control: "prompt"|"text"|"number"|"range"|"select"|"toggle"|"image"|"images";
    label?: string; required?: boolean; default?: any;
    choices?: { value: string; label: string }[];   // UI 帶 label，CLI 取 value
    min?: number; max?: number; step?: number; placeholder?: string;
    section?: string;                        // UI 分組
    visible?: (s) => boolean;
  }
  interface UnifiedCommand {
    action: string; submitLabel: string; runningLabel: string;
    fields: UnifiedField[];
    isDisabled?: (s)=>boolean; buildParams?: (s)=>Record<string,any>;
  }
  ```
  control→CLI type 對應：prompt/text/image→string、number/range→number、toggle→boolean、
  select→select、images→multiselect。
- 兩個 adapter（取代手動同步）：
  - `schemas/toCli.ts`：`toCliFields(cmd)` 產生現有 `lib` 的 `Record<key, FieldSchema>`，供 `lib/args.ts`
    的 `buildCliArgs`/`validateParams` 直接沿用（**簽名不變**）。
  - `schemas/toForm.ts`：`toSections(cmd)` 依 `section` 把 fields 組成現有 `CommandForm` 吃的
    `CommandSchema`（sections/fields），UI 型別與 label 直接來自 field。
- 逐一把 `lib/schemas/<cmd>.ts` 與 `frontend/schemas/<cmd>.ts` 合併成 `schemas/<cmd>.ts`（一份 `UnifiedCommand`）。
- `lib/schemas.ts` 的 `COMMAND_SCHEMAS` 改為 `mapValues(UNIFIED, toCliFields)`；
  `frontend/schemas/index.ts` 的 `*_SCHEMA` 改為 `toSections(UNIFIED.foo)`。**下游 import 路徑與消費形狀不變**，
  風險侷限在 schema 層。
- `buildParams`（如 controlnet 的「==default 就省略」）屬 UI 端，保留在 `UnifiedCommand.buildParams`。

關鍵檔：`schemas/types.ts`(新)、`schemas/toCli.ts`(新)、`schemas/toForm.ts`(新)、
`schemas/<cmd>.ts`(新，15 個)、`lib/schemas.ts`、`frontend/schemas/index.ts`、`lib/args.ts`(僅確認相容)。
舊 `lib/schemas/*`、`frontend/schemas/*` 個別檔在遷移後刪除。

### ✅ Phase 3 — 抽出共用 custom-view hook [done 2026-06-12 bundle 73 modules 1.21MB OK]

`VideoGenerateView`/`VideoRelayView`/`VideoRestoreView`（各 170–290 行）共享同一段樣板：
相同的 10 行 import、`useCommandView`+`useDefaultState`、`handleSubmit` 組 params→POST `/api/run`→`handleJobStart`、
底部 `JobOutputPreview`+`LogViewer`+`SelfTestButton` 區塊。

- 新增 `frontend/hooks/useCommandJob.ts`：封裝 `useCommandView`+`useDefaultState`+`submit(params)`（含對 `/api/run` 的 fetch
  與錯誤處理），回傳 `{ state, setField, job, loading, submit, handleCancel }`。
- 新增 `frontend/components/CommandViewShell.tsx`：共用底部結果區（output preview + logs + self-test + 導向 gallery），
  讓 custom view 只專注自己獨特的 mode tabs / preset / 欄位。
- 三個 video view 改用上述兩者；每支預期可從 ~280 行縮到 ~150 行，且彼此仍各自獨立檔。

關鍵檔：`frontend/hooks/useCommandJob.ts`(新)、`frontend/components/CommandViewShell.tsx`(新)、
`frontend/views/workflow/Video*.tsx`(3 支)。

### ✅ Phase 4 — Per-view scoped CSS Modules [done 2026-06-12 JS 1.22MB + CSS 26.64KB OK]

Bun 1.3.14 的 bundler 原生支援 `.module.css`（scoped）與一般 CSS import。改法：

- **全域基底**留一份：把 theme 變數（`:root --bg/--accent/...`）、reset、跨 view 共用的
  `.btn-*`/`.form-*`/`.status-*`/sidebar 等抽到 `frontend/styles/global.css`，在 `app.tsx` 以
  `import "./styles/global.css"` 一次匯入。
- **per-view/組件樣式**搬成就地 `*.module.css`，元件以 `import s from "./Foo.module.css"` + `className={s.card}` 引用。
  優先搬 prefix 明確、單一歸屬的群組：`.mf-*`(ImagePreview)、`.gallery-*`、`.mc-*`(ModelCheck)、`.jv-*`(JsonViewer)、
  `.inspector-*`(DomInspector)、`.log-*`(LogViewer)。
- **build/serve 調整**：因 CSS 改由 entry import 進 bundle，`Bun.build` 會額外輸出 CSS chunk。
  - `api/routes.ts` `_doBuild`：保存 outputs 中的 CSS 輸出，新增路由服務 `/frontend/bundle.css`；
    移除 `/frontend/styles.css` 靜態服務（或保留為 global.css 過渡）。
  - `frontend/index.html`：`<link>` 指向 `/frontend/bundle.css`。
  - `server.ts` 的 fs.watch 已涵蓋 `.css`，HMR 沿用。
- 逐組件遷移、每搬一組就 `bun run dev` 目視確認，避免一次大改。

關鍵檔：`frontend/styles/global.css`(新)、各 `*.module.css`(新)、對應元件 `.tsx`、`api/routes.ts`、`frontend/index.html`。

---

## 重用的既有資產（不要重造）

- `frontend/views/CommandView.tsx` `createCommandView(schema)` — Phase 1 descriptor 的 `component` 直接沿用。
- `lib/args.ts` `buildCliArgs`/`validateParams` — Phase 2 只換它讀的 `COMMAND_SCHEMAS` 來源，邏輯不動。
- `frontend/components/CommandForm.tsx` 吃的 `CommandSchema`(sections/fields) 形狀 — Phase 2 `toSections` 產出此形狀，CommandForm 不改。
- `frontend/hooks/useCommandView.ts`/`useDefaultState.ts` — Phase 3 包進 `useCommandJob`，不重寫。
- `frontend/context/NavigationContext.ts`、`SelfTestButton`、`JobOutputPreview`、`LogViewer` — Phase 3 shell 內沿用。

## 不在範圍內

- 不引入 Vite / Next / TanStack（使用者已選留在 Bun.build）。
- 不改 `/api/run`、subprocess、job 持久化、python `run.py` 介面。
- 不改 Gallery/Config/Jobs 三個非指令 view 的行為（Phase 1 仍以 app.tsx 特例渲染）。
- lazy code-splitting（`splitting:true` + 多 chunk serving）列為**可選後續**，非本次必要。

## 驗證

每個 Phase 完成後：

1. `cd bun/gui-movie-director && lsof -ti :3099 | xargs kill 2>/dev/null; bun run dev`
   — 確認 bundle 編譯成功、無 TS 錯誤、瀏覽器 http://localhost:3099 正常載入。
2. **Phase 1**：側欄所有群組/指令出現且可點開；每個 view 能渲染表單（對照改前的 `COMMAND_GROUPS` 清單無遺漏）。
3. **Phase 2**：抽樣 controlnet/t2i/i2i — 表單欄位、選項、預設值與改前一致；實際送出一個 job，
   檢查 `lib/args.ts` 產生的 CLI 參數正確（可在 `api/jobs.ts` log 或實跑 `/api/run` 比對 spawn 的 argv）。
   特別驗 select choices、required、`buildParams` 省略邏輯（controlnet_strength==1.0 應不帶 flag）。
4. **Phase 3**：三個 video view 的 mode/preset 切換、送出、log/output 顯示與改前行為一致。
5. **Phase 4**：逐組件目視比對樣式無走樣；確認 `/frontend/bundle.css` 正常服務、HMR 改 `.module.css` 會即時反映。
6. 全程 `git diff` 自審；完成後可選 `/code-review` 跑一輪。
