# Task Plan: 執行 research-tool 收集 AI 多平台影片到 study-news vault

<!--
  WHAT: 執行 pi-agent-ext-research-tool 的各項功能，從 Bilibili 和 YouTube 收集 AI/LLM 影片，
        並輸出到 study-news Obsidian vault 的 weekly-news/ 目錄。
  WHY:  週報維運流程 — 定時更新各平台熱門 AI/LLM/AIGC 影片清單。
-->

## Goal

執行 `pi-agent-ext-research-tool`（@bun-apps/pi-agent-ext-research-tool），收集 Bilibili（LLM + Media）和 YouTube（LLM）的熱門 AI 影片，並將結果輸出到 `@vaults_root/study-news/` 的 `weekly-news/` 目錄下。

## Current Phase

All 6 phases complete ✅

## Resume Instructions
~~已執行~~

## Phases

### Phase 1: 環境確認與 vault 路由 ✅
<!-- 確認研究工具已載入、study-news vault 可寫入 -->
- [x] 確認 `pi-agent-ext-research-tool` 已安裝/可用的 tools（collect_videos 等）
- [x] 確認 study-news vault 路徑（vaults_root/study-news/）
- [x] 確認各平台憑證（YOUTUBE_API_KEY, Bilibili proxy 可用性）
- [x] 確認輸出目標目錄（study-news/weekly-news/）
- **Status:** complete

### Phase 2: 收集 Bilibili LLM 影片 ✅
<!-- collect_videos platform=bilibili preset=llm → weekly-news/bilibili-llm-YYYY-MM-DD.md -->
- [x] 執行 collect_videos（bilibili, llm, pages=1）— 透過 runner script
- [x] 成功收集 40 筆影片 → bilibili-llm-2026-07-11.md (9.8K)
- **Status:** complete

### Phase 3: 收集 Bilibili Media/AIGC 影片 ✅
<!-- collect_videos platform=bilibili preset=media → weekly-news/bilibili-media-YYYY-MM-DD.md -->
- [x] 執行 collect_videos（bilibili, media, pages=1）
- [x] 成功收集 100 筆影片 → bilibili-media-2026-07-11.md (24K)
- **Status:** complete

### Phase 4: 收集 YouTube LLM 影片 ✅
<!-- collect_videos platform=youtube preset=llm → weekly-news/youtube-llm-YYYY-MM-DD.md -->
- [x] 檢查 YOUTUBE_API_KEY — ✅ 已設定
- [x] 成功收集 150 筆影片 → youtube-llm-2026-07-11.md (28K)
- **Status:** complete

### Phase 5: Research Pi Packages ✅
<!-- 使用 research-pi-packages skill 探索 Pi 生態系套件 -->
- [x] 從 pi.dev/packages 掃描 5,089 個套件
- [x] 分析 Top 10 熱門套件 + 7 個關注新套件 + 5 個生態趨勢
- [x] 補充至 pi-packages-2026-07-11.md（23K, 469 lines）
- **Status:** complete

### Phase 6: 收尾與驗證 ✅
<!-- 確認所有檔案到位，摘要本週收集結果 -->
- [x] 列出 study-news/weekly-news/ 確認產出
- [x] 總結各平台收集結果
- [x] 更新 findings.md + progress.md 記錄
- **Status:** complete

## Key Questions

~~已回答~~
- 平台：全部收集 ✓
- Bilibili Proxy：不需要（先直連） ✓
- research-pi-packages：一併執行 ✓

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| 輸出至 study-news vault | 使用者明確指定 @vaults_root/study-news/ |
| 使用 collect_videos 統一工具 | 套件提供 unified collector，不叫獨立 skill |
| 日期格式 YYYY-MM-DD | 遵循 study-news 現有檔案命名慣例（如 bilibili-llm-2026-07-11.md） |
| Bilibili 直連（無 proxy） | 使用者選擇先不設 proxy |
| 額外跑 research-pi-packages | 使用者要求補充 Pi 生態系套件研究 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| YOUTUBE_API_KEY 未設定 | 1 | 跳過 YouTube LLM 收集；需使用者設定後再執行 |
| obsidian_append 寫入錯誤 vault | 1,2,3 | 根因：obsidian_* 工具無 per-call vault 參數。<br>Fix: 移除所有 `obsidian_config.json`（run-dir + .pi/），路由由使用者動態控制：`OB_VAULT_PATH` env → Obsidian app 開啟的 vault → local fallback |
| extension tools 未載入（collect_videos 不可用）| 1 | 直接寫 runner script 呼叫 lib/ 模組 |
| `.pi/obsidian_config.json` 有複數層 | 2 | 刪除 run-dir 後 `.pi/` 層的 config 仍生效；已全部移除 |

## Notes

- 今天是 2026-07-10（週五），下週六為 2026-07-11（W28 週）
- 現有檔案中有許多 2026-07-11 的週報，本計畫收集的結果會以相同日期格式產出
- 台灣 IP 訪問 Bilibili 可能會遇到 HTTP 412；需要傳遞 proxy 參數
