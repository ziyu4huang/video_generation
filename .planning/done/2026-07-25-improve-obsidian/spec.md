# Spec: 全面改善 pi-agent-ext-obsidian(結構重構 + 正確性修補 + 護欄)

## Problem Statement

`pi-agent-ext-obsidian` 是一個成熟、已驗收的套件(`ENHANCEMENT-PRD.md` 的 A1–A8 / B1–B6 / C1–C8 / D1–D5 **全部 DONE**;384/385 測試通過,唯一失敗是缺 git submodule 的 snapshot skip,非回歸;無 TODO/FIXME、無殘留 console.log、git 乾淨)。它的功能債已清,但累積了三類**非功能性**債:

1. **結構債(god files)。** 核心程式庫 `src/obsidian-lib.ts` 是 **3918 行 / ~115 個 exports**,把 ~12 個不相關關注點塞在同一檔案:vault 解析、路徑安全、read cache、search/matchers、vault index、graph 查詢、wiki-link rewrite、frontmatter、subagent(distill/garden)、zettel 驗證、deterministic health-check、routing 文字。`extensions/obsidian.ts` 2103 行。導航困難、review diff 龐大、無法對單一關注點做聚焦測試。原始作者**已經**用 section-header 註解(`// ---- Vault index (B1) ----` 等)畫出邊界,但從未實際切檔。
2. **既存 open bug。** `renameOverwrite` 在 win32 上 rename-onto-existing 會 `EPERM`/`EEXIST`(只特判 `EXDEV`);`moveNote`/`deleteNote` 用循序 `await` 改寫 inbound links;semantic search 在 `obsidian_distill`/`zk_ingest` 後需手動 re-index(文件 gap #5)。
3. **缺型別護欄。** 此 package **無 `tsconfig.json`**;`bun test` 只透過 bun transpile,**不做完整 `tsc` 型別檢查**。code 註解自己提到曾冒出 ~80 個 implicit-any。無型別閘門 = 重構與 bug 修補缺乏安全網。

**目標**:在不改變任何公開工具行為的前提下,償還這三類債——先建型別護欄,在護欄下安全拆分 god file,再修 open bug。

## Solution — 選項 A(先護欄 → 安全拆分 → 修 bug → 收尾)

四階段、各自獨立 commit、各自可驗證、可單獨 rollback:

```
Phase 0  型別護欄        加 tsconfig + typecheck script;分類並清零既存錯誤
   ↓     (建立安全網,讓 Phase 1 的機械式拆分有型別保護)
Phase 1  結構拆分        obsidian-lib.ts → 13 個聚焦模組 + barrel re-export
   ↓     (純 move + re-export,零邏輯變更,測試須全程 384/385 綠)
Phase 2  正確性修補      Windows overwrite fallback / 並行 link rewrite / opt-in semantic re-index
   ↓
Phase 3  護欄收尾        穩定漂移 snapshot 失敗訊息;確認 schema-cost regression guard
```

**核心不變量(Phase 1 正確性關鍵)**:`extensions/obsidian.ts` 的 `export * from "../src/obsidian-lib.ts"` 與所有 `import { ... } from "../src/obsidian-lib.ts"` 在拆分後**位元級不變**——因為 `src/obsidian-lib.ts` 降級為薄 barrel,逐一 `export * from "./lib/<module>"`。這是「行為零變更」的保證:任何外部消費者(`pi-agent-ext-knowledge-card`、`pi-agent-cli`、`lib/index.ts`)與內部 `extensions/obsidian.ts` 都不需要改任何 import 路徑。

## Phase 1 — 模組拆分設計

依原始作者既有的 section-header 邊界切檔。依賴圖為**無環 DAG**(下方驗證)。

### 模組清單(`src/lib/` 下,13 個模組 + 1 個 barrel)

| 模組 | 主要 exports | 依賴 |
|------|--------------|------|
| `lib/errors.ts` | `errMsg`, `ErrCode`, `VaultError`, `fsErrCode`, `classifyFsError`, `toolError`, `toolErrorFromCaught` | *(leaf)* |
| `lib/utils.ts` | `execFileP`, `_findMonorepoRoot`, `_missingDeps`(process / monorepo 葉節點) | *(leaf)* |
| `lib/path-safety.ts` | `safeNotePath`, `fsLstat`, `fsRealpath`, `WRITE_BLOCKLIST`, `assertWithinVault`, `assertWritablePath` | errors |
| `lib/fs-cache.ts` | `atomicWriteFile`, `renameOverwrite`, `noteMtime`, `mtimeConflict`, `CacheEntry`, `fileCache`, `fileCacheMax`, `readCached`, `invalidateCache`, `__fileCacheOrder`, `readBatched`, `listNotes`, `countNotes` | errors |
| `lib/vault-resolution.ts` | `OBSIDIAN_JSON`, `VaultEntry`, `ObsidianConfig`, `VaultSource`, `ResolvedVault`, `VaultConfigFile`, `runDirPath`, `runDirConfigPath`, `personalConfigPath`, `projectConfigPath`, `vaultConfigPath`, `readPersonalConfig`, `readProjectConfig`, `readVaultConfig`, `writeVaultConfig`, `readObsidianVaults`, `isDirEmpty`, `seedFromTemplate`, `basenameOf`, `resolveVault`, `listVaultCandidates`, `openObsidianUri`, `launcherForUri` | utils, errors |
| `lib/frontmatter.ts` | `ParsedFrontmatter`, `parseFrontmatter`, `stripScalar`, `extractWikiLinks`, `stringifyFrontmatter`, `updateFrontmatter`, `appendUnderHeading` | errors, fs-cache |
| `lib/index.ts` | `NoteMeta`, `VaultIndex`, `contentTrigrams`, `trigramCandidates`, `parseNoteMeta`, `titleKeysFor`, `indexNote`, `unindexNote`, `resolveLink`, `reindexFile`, `dropIndex`, `indexCache`, `indexInFlight`, `INDEX_POLL_MS_DEFAULT`, `indexPollMs`, `indexRefreshAt`, `getIndex`, `buildIndex`, `rebuildReverseAdjacency`, `INDEX_CACHE_VERSION`, `indexCachePath`, `statMtimes`, `serializeIndex`, `saveIndex`, `loadCachedIndex`, `refreshIndex` | errors, fs-cache, frontmatter |
| `lib/search.ts` | `MatchMode`, `NoteField`, `isSubsequence`, `levenshtein`, `fuzzyMatch`, `deescapeRegex`, `buildMatcher`, `computeFieldLabels`, `SearchMatch`, `noteRecencyDays`, `fieldWeight`, `pickField`, `renderContext`, `searchVault` | errors, fs-cache(**近葉**——trigram 前篩在工具層,不在 `searchVault` 內) |
| `lib/graph.ts` | `resolveWikiLink`, `backlinkPaths`, `tagPaths`, `GraphMode`, `GraphResult`, `graphOutgoing`, `graphOrphans`, `graphDeadLinks`, `buildAdjacency`, `getAdjacency`, `graphNeighbors`, `findBacklinks`, `findTagNotes`, `queryNotes`, `detectTitleStyleOutliers` | index |
| `lib/links.ts` | `rewriteLinkToken`, `LINK_KEEP`, `LINK_DELETE`, `rewriteLinksProtected`, `moveNote`, `deleteNote` | errors, fs-cache, index(backlinks) |
| `lib/subagent.ts` | `ZETTEL_SYSTEM_PROMPT`, `GARDEN_SYSTEM_PROMPT`, `getPiInvocation`, `SubagentOptions`, `makeSubagentProgressLogger`, `buildSubagentArgs`, `WEAK_MODEL_PATTERNS`, `isWeakModel`, `ResolvedModel`, `resolveSubagentModel`, `parseStructuredResult`, `runSubagentWithRetry`, `isTransientError`, `runSubagentWithRetryImpl`, `runSubagent`, `toolAllowlist`, `assertExtensionApi` | utils, errors |
| `lib/zettel.ts` | `ZETTEL_MAX_BYTES`, `ZETTEL_REQUIRED_KEYS`, `NoteValidation`, `validateZettelNote`, `validateZettelNotes`, `IntegrityIssue`, `validateNoteIntegrity`, `validateNoteIntegrityBatch`, `repairZettelFrontmatter`, `FrontmatterRepair`, `mtimeToZettelIds`, `DetHealthResult`, `registerDeterministicHealthCheck`, `runDeterministicHealthCheck` | errors, index, frontmatter |
| `lib/routing.ts` | `scheduleVaultBanner`, `searchRoutingDescription`, `searchReferenceText`, `obsidianRoutingDescription`, `obsidianActionReferenceText` | vault-resolution |
| `src/obsidian-lib.ts`(barrel) | `export * from "./lib/errors"` … 逐一 re-export 全部 13 模組 | — |

### 依賴 DAG(無環驗證)

```
errors ─┬─→ path-safety
        ├─→ fs-cache ─┬─→ search        ← 近葉:只用 fs-cache + 自有 helpers
        │             ├─→ frontmatter ─→ index ─┬─→ graph
        │             └─→ index ────────────────┼─→ links
        └─→ ...(被所有模組引用)                  └─→ zettel
utils ──┬─→ vault-resolution ──→ routing
        └─→ subagent
```

- `errors` 與 `utils` 是唯二葉節點。
- **已 grep 驗證的關鍵單向邊**:`index → frontmatter`(`parseNoteMeta` 呼叫 `extractWikiLinks`,行 1509+);反向**不成立**——`updateFrontmatter`/`appendUnderHeading` 不呼叫 `getIndex`(驗證 grep 空)。故 `index` 與 `frontmatter` 無循環。
- **`search` 不依賴 `index`**:`searchVault` 本體只用 `listNotes`/`readBatched`(fs-cache)與自有的 `computeFieldLabels`/`buildMatcher`/`noteRecencyDays` 等。C5 trigram 前篩**不在** `searchVault` 內,而在 `obsidian_search` 工具 handler(`extensions/obsidian.ts:793-794`)呼叫 `refreshIndex` + `trigramCandidates` 後把 scope 過的 `paths` 傳進 `searchVault`。這使 lib 拆分後 `search.ts` 保持 hermetic。
- **`links` 不依賴 `frontmatter`**:`moveNote`/`deleteNote` 不呼叫 frontmatter 函式(驗證 grep 空),只用 `index`(backlinks)+ `fs-cache`(read/write)+ `errors`。
- Plan 階段以 `grep -rn "from \"\./"` 對每個新模組復核無殘留跨層引用,並以 `bunx tsc --noEmit` 確認無循環。

### 拆分手法(零行為變更的保證)

1. **逐模組、逐一 commit**:每搬一個模組→跑 `bun test`→須 384/385 綠才進下一個。順序依 DAG 拓撲:errors → utils → path-safety/fs-cache/vault-resolution/frontmatter → index → search/graph/links/zettel/subagent/routing。
2. **純剪貼 + 調整 import**:把該 section 的程式碼原樣搬到新檔;新檔只加它需要的 `import { ... } from "./<dep>"`;**不改任何函式內部邏輯、不改簽名、不改註解**。
3. **barrel 最後**:13 個模組都搬完後,把 `src/obsidian-lib.ts` 內容替換成 13 行 `export *`。此後 `extensions/obsidian.ts` 與所有外部 import 路徑完全不變。
4. **`__tests__` 不動**:測試檔維持 `from "../src/obsidian-lib.ts"`(透過 barrel)或既有相對路徑——barrel 保證符號仍在。

> 若搬移過程中發現某符號的真正歸屬與上表不符(例如 `queryNotes` 實際只用 index 不用 frontmatter),Plan 階段以 grep 定位真正歸屬後調整;不變量是「barrel 涵蓋全部原 exports」。

## Phase 0 — 型別護欄(先於 Phase 1)

1. 新增 `bun-apps/pi-agent-ext-obsidian/tsconfig.json`(比照同 repo 其他 `pi-agent-ext-*` 套件;`noEmit`、`strict` 或與同儕一致、`moduleResolution: bundler`、含 `extensions/` 與 `src/`)。
2. `package.json` 加 `"typecheck": "bunx tsc --noEmit"` script。
3. 跑一次 `bunx tsc --noEmit`,**記錄**既存錯誤清單(預期有 implicit-any 等),分類:
   - 可安全修(加型別標註)→ 修。
   - 需 `// @ts-expect-error` + 註解理由的(如 `_capturedTools` runtime metadata)→ 標註。
   - 屬於 peer 套件型別缺失的 → 記錄為已知,不阻塞。
4. **驗收**:`bunx tsc --noEmit` 退出碼 0(或在 spec 記錄的已知豁免清單內)。此後 Phase 1/2 的每個 commit 都須通過 typecheck。

## Phase 2 — 正確性修補

### 2.1 Windows atomic-overwrite(`renameOverwrite`)

現況:`renameOverwrite`(現 `fs-cache.ts`)只 special-case `EXDEV`(cross-device)。win32 上 `fs.rename` 落在已存在的 target 會丟 `EPERM`/`EEXIST`,導致所有 in-place 編輯(append / frontmatter update / move-with-overwrite)在 Windows 失敗(`KNOWN-ISSUES.md` *(open)*)。

修法:捕獲 `EPERM`/`EEXIST`(可限 `process.platform === "win32"` 或一律安全)→ `await unlink(target)` 後重試 `rename` 一次;仍失敗則 fallback `cp(src, dst, { force: true })` + `unlink(src)`。保留 `EXDEV` 既有 copy+delete 路徑。

測試:新增單元測試模擬 `EPERM`/`EEXIST` 錯誤碼路徑(注入 mocked fs 或 spy `rename`/`unlink`),斷言 fallback 成功且 target 內容正確。macOS/Linux 走既有 `rename` 快路徑不受影響。

### 2.2 並行化 inbound-link rewrite(`moveNote` / `deleteNote`)

現況:兩函式對每個 backlink source 做 `for (const src of sources) { await readFile; await writeFile; }` 循序 `await`(`KNOWN-ISSUES.md` 標記 *deferred*)。各 source 互相獨立。

修法:改 `await Promise.all(sources.map(async (src) => { ... }))`,per-source 失敗仍收集進 `failedSources`(精確可重試清單,語意不變)。`moveNote` 既有的「先搬檔再改 backlink、rename 失敗即 bail 不動 graph」順序保持不變。

測試:新增測試建一個有多條 inbound link 的 fixture vault,move/rename/delete 後斷言所有 source 的 `[[wiki-link]]` 已正確改寫、`failedSources` 為空。

### 2.3 Semantic re-index auto-hook(opt-in,預設關閉)

現況:`obsidian_distill` / `zk_ingest` 寫入新卡後,vault-mind 的向量索引不會自動更新,需手動 `POST /api/index force_reindex:true`(README 文件 gap #5)。

修法:**新增環境變數 `VAULT_MIND_AUTO_REINDEX`**(預設未設=關閉)。`obsidian_distill` 的 post-run audit 與(若此套件擁有)`zk_ingest` 成功路徑上,若該 env 為 truthy 且 `VAULT_MIND_BASE_URL` 已設,**fire-and-forget** 觸發 re-index(沿用 README 已驗證的 `/api/index force_reindex:true` + poll job 流程;失敗只 log 警告,不影響主流程、不改工具回傳)。

**為何 opt-in**:維持 pi-obsidian「hermetic、filesystem-only except opt-in semantic service」原則。預設關閉 = 不引入任何 HTTP 耦合;只有明確設定的環境才啟用。README 補一段說明。

測試:`VAULT_MIND_AUTO_REINDEX` 未設時→不發 HTTP(spy `fetch` 斷言未被呼叫);設為 `1` 且服務可達→斷言發出正確 `POST /api/index` 請求;服務不可達→只警告不拋錯。

## Phase 3 — 護欄收尾

- **漂移 snapshot 失敗訊息**:real-vault snapshot 測試已 `skipIf(!vaultAvailable())` gated;改善其 skip/fail 訊息,明確指引 `git submodule update --init vaults_root/pi-agent-vault` 與 `bun run regen:baseline`。(既有 frozen in-package contract `frozen-baseline.txt` 已是 CI 安全的位元級契約,不動。)
- **schema-cost regression guard**:確認 Phase 1–2 後 `extensions/__tests__/perf/schema-cost.regression.test.ts` 仍 ≤ 280 tokens(拆分不應改變註冊的 fat tool 數量)。
- **typecheck 入 CI 流程**(若此 package 有 CI hook):把 `bun run typecheck` 加進 test 流程。

## Verification(每階段結束都跑)

1. **全程**:`( cd bun-apps/pi-agent-ext-obsidian && bun test extensions/__tests__/ )` → 須 **384/385 pass**(唯一 skip/fail 是缺 submodule 的 snapshot)。
2. **全程**:`( cd bun-apps/pi-agent-ext-obsidian && bun run typecheck )` → 退出碼 0(Phase 0 建立後)。
3. **Phase 1 後**:grep 確認 `extensions/obsidian.ts` 與 `lib/index.ts`、`extensions/__tests__/` 的 import 路徑**零改動**;`src/obsidian-lib.ts` 只剩 barrel re-export。
4. **Phase 2 後**:新測試(Win overwrite fallback / 並行 link rewrite / semantic auto-hook 三態)全綠;既有 `rewriteProtection`/`expectedMtime`/`subagentSafety` 套件不受影響。
5. **Phase 3 後**:perf schema-cost regression guard ≤ 280 tokens;snapshot 訊息改善。
6. **跨套件不破壞**:`( cd bun-apps/pi-agent-ext-knowledge-card && bun test )` 與 `pi-agent-cli` 相關測試仍綠(它們 import `@repo/pi-agent-ext-obsidian`,barrel 保證符號仍在)。

## Risks & Mitigations

1. **拆分遺漏 re-export → 外部 import 斷裂** — 緩解:barrel `export *` 涵蓋全部原 exports;Plan 階段比對 `grep -nE "^export " src/obsidian-lib.ts`(原)與 13 模組合集逐一核對不漏;每搬一模組即跑測試 + typecheck。
2. **隱藏跨層依賴造成循環** — 緩解:依 DAG 拓撲順序搬移;每模組搬完跑 `bunx tsc --noEmit`(tsc 報循環);必要時用 `bunx madge --circular src/`。
3. **Phase 0 typecheck 暴露大量既存錯誤拖累時程** — 緩解:先記錄分類,只修可安全修的;屬 peer 型別缺失或需設計決策的以 `// @ts-expect-error` + 理由暫豁並列於 spec,不阻塞 Phase 1。
4. **Windows overwrite fallback 在 macOS/Linux 無法實機驗證** — 緩解:以 mocked fs / spy 驗證錯誤碼分支邏輯;fallback 採標準 node API(`unlink`/`cp`),跨平台行為可推理。
5. **semantic auto-hook 引入非預期 HTTP** — 緩解:預設關閉、env-gated;預設路徑 spy 斷言 `fetch` 未呼叫;僅在兩個 env 都設時才啟用。
6. **`zk_ingest` 所在套件歸屬** — `zk_ingest` 屬 `pi-agent-ext-knowledge-card`,非本套件。本 spec 的 2.3 只修本套件擁有的 `obsidian_distill`;`zk_ingest` 的 auto-hook 列為 knowledge-card 的後續(Out of Scope),本 spec 僅在 README 註記兩者皆需 re-index。

## Out of Scope

- **拆分 `extensions/obsidian.ts`(2103 行)** — 它的 captured-tool / fat-dispatcher 模式內聚,內容多為 schema 字串,拆它對可維護性收益有限卻增加 capture 模式複雜度。列為未來選項(見 Further Notes)。
- 任何**工具行為 / 公開簽名變更**——Phase 1 是純結構重構,行為位元級不變;Phase 2 修補不改任何工具的回傳契約。
- `zk_ingest` 的 semantic auto-hook(屬 knowledge-card 套件)。
- 新增功能(新工具、tag manager、template applier 等)。
- 改 regex/words/fuzzy 為索引加速(文件標記 by-design full-scan)。
- 遷移 `vaults_root/pi-agent-vault` submodule 或重產 real-vault snapshot。

## Further Notes

- **未來:拆 `extensions/obsidian.ts`** — 若日後想進一步收斂,可把 20 個 captured tool 依網域拆成 `extensions/tools/{read-write,search,graph,subagent}.ts`,各 export `register(capture, helpers)`。第一輪先不做,待 lib 拆分穩定後再評估。
- **CONTEXT.md** — 拆分後 `CONTEXT.md` 的 ubiquitous language 不變(職責詞彙仍對應同一套能力),但可在各模組頂部補一行指向所屬語言條目;非必要。
- **無 ADR 需求** — 本重構不改架構邊界或跨套件依賴,僅檔案內部重組,不構成 ADR 級決策。
