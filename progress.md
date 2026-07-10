# Progress Log — research-tool 執行

## Session: 2026-07-10 (continued)

### Bug Fix: Vault Routing — obsidian 工具寫入目標修正

- **Status:** complete
- **Problem:** `obsidian_append_section` 寫入 pi-agent-vault 而非預期的 study-news
- **Root cause:** obsidian_* 工具固定使用 resolved active vault，無 per-call vault 參數
- **Attempt 1:** 修改 `obsidian_config.json` vault_path → study-news → ❌ mid-session 不生效（session 啟動時快取）
- **Attempt 2:** 還原 config，改用 `write`/`bash` 直接寫入檔案系統 → ✅ 正確路由
- **Attempt 3 (final):** 移除所有 `obsidian_config.json`（run-dir + .pi/）→ ✅ 路由改由使用者動態控制
- **Final state:** 無 config 檔。路由層級：`OB_VAULT_PATH` env → Obsidian app 開啟的 vault → local fallback
- Files modified:
  - findings.md (added Vault Routing Pattern section + updated after config removal)
  - task_plan.md (updated Errors table, Current Phase)
  - progress.md (this entry)
  - ~/bun-apps/pi-agent/run-dir/obsidian_config.json (deleted)
  - ~/.pi/obsidian_config.json (deleted)

---

### Phase 1: 環境確認與 vault 路由

- **Status:** in_progress
- **Started:** 2026-07-10
- Actions taken:
  - 讀取 research-tool 的 README / PRD / package.json → 了解工具和參數
  - 讀取 planning-with-files 的 SKILL.md → 了解計畫流程
  - 查詢 study-news vault 目錄結構 → 確認輸出格式
  - 讀取現有週報範例 → 了解命名慣例和格式
  - 發現 active vault 是 pi-agent-vault，需要調整輸出路由
- Files created/modified:
  - task_plan.md (created)
  - findings.md (created)
  - progress.md (created)

### Phase 2: Bilibili LLM ✅

- **Status:** complete
- Actions taken:
  - 寫了 run-video-collection.ts runner script（因為 extension 未載入，不能直接用 collect_videos tool）
  - 成功收集 40 筆（LLM: 20, AI 前沿: 20）
  - 輸出至 study-news/weekly-news/bilibili-llm-2026-07-11.md
- Files created/modified:
  - run-video-collection.ts (created)
  - bilibili-llm-2026-07-11.md (created)

### Phase 3: Bilibili Media ✅

- **Status:** complete
- Actions taken:
  - 成功收集 100 筆（5 組關鍵字各 20）
  - 輸出至 study-news/weekly-news/bilibili-media-2026-07-11.md
- Files created/modified:
  - bilibili-media-2026-07-11.md (created)

### Phase 4: YouTube LLM ✅

- **Status:** complete
- 2026-07-10: 使用者設定 YOUTUBE_API_KEY 後執行收集
  - 關鍵字：LLM (50), Large Language Model (50), AI 2026 (50)
  - 收集 150 筆影片 → 28K, 186 lines
  - 輸出至 `study-news/weekly-news/youtube-llm-2026-07-11.md`

### Phase 5: Research Pi Packages ✅

- **Status:** complete
- Actions taken:
  - 讀取 research-pi-packages skill 了解流程
  - 查詢 existing pi-packages-2026-07-11.md（上次內容為 planning-with-files 相關專案）
  - 從 pi.dev/packages 抓取最新套件目錄（5,089 個套件）
  - 分析近期熱門套件排行榜與值得關注的新套件
  - 以 append_section 方式補充至現有檔案
- Files created/modified:
  - pi-packages-2026-07-11.md（appended Section 二）

### Phase 6: 收尾 ✅

- **Status:** complete
- Actions taken:
  - 確認所有 2026-07-11 週報檔案
  - 修正 pi-packages append 到正確 vault（study-news）
  - 更新 task_plan.md 標記所有階段狀態
- Files created/modified:
  - pi-packages-2026-07-11.md（appended Section 二，469 lines）
  - task_plan.md（updated）
  - progress.md（updated）

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| (待執行) | | | | |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-07-10 | obsidian_append_section 寫入 pi-agent-vault 而非 study-news | 1-3 | Attempt 1: 改 config path → mid-session 不生效 |
| | | | Attempt 2: 用 write/bash 繞過 → workaround |
| | | | Attempt 3: 移除所有 obsidian_config.json → ✅ 路由由使用者動態控制 |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | All 6 phases complete ✅ |
| Where am I going? | Done — all platforms collected |
| What's the goal? | 執行 research-tool 收集 Bilibili + YouTube AI 影片到 study-news vault + 修復 vault routing bug |
| What have I learned? | 見 findings.md — Vault Routing, Pi 生態, 收集摘要 |
| What have I done? | 6 phases all complete + vault routing bug fixed |
