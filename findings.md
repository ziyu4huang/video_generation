# Findings & Decisions — research-tool 執行計畫

## Requirements

- 收集 Bilibili LLM 熱門影片（關鍵字：LLM 大模型 等）
- 收集 Bilibili Media/AIGC 影片（關鍵字：AI 影片生成, AI 繪畫 等）
- 收集 YouTube LLM 熱門影片
- 輸出至 study-news vault 的 weekly-news/ 目錄

## Research Findings

### pi-agent-ext-research-tool 提供的工具

| Tool | 用途 |
|------|------|
| `collect_videos` | 統一收集器，platform + preset 參數 |
| `organize_vault_notes` | 自動補 frontmatter tags/aliases/created |
| `import_memory_to_vault` | 匯入 hermes 記憶到 vault-mind jsonl |

### collect_videos 參數

- `platform`: bilibili | youtube
- `preset`: llm | media | custom
- `keywords`: 自訂關鍵字陣列（preset=custom 時必填）
- `pages`: 每組關鍵字頁數（預設 1）
- `order`: 排序（bilibili: click|pubdate|dm|stow / youtube: relevance|date|viewCount）
- `popular`: Bilibili 全站熱門（boolean）
- `proxy`: Bilibili proxy URL（台灣 IP 可能需要）
- `outputPath`: 自訂輸出路徑（預設 study-news 的路徑？需確認）

### 輸出格式對照

現有 study-news/weekly-news/ 檔案前綴：
- `bilibili-llm-YYYY-MM-DD.md`
- `bilibili-media-YYYY-MM-DD.md`
- `youtube-llm-YYYY-MM-DD.md`
- `pi-packages-YYYY-MM-DD.md`
- `arxiv-weekly-YYYY-MM-DD.md`
- `github-weekly-YYYY-MM-DD.md`

### 注意事項

- Bilibili 從非中國 IP 訪問可能會收到 HTTP 412。需要使用 proxy（如 http://127.0.0.1:7890）
- YouTube Data API 每日配額 10,000 units（每次搜尋約 100 units）
- 輸出目錄依賴 vault 解析：OB_VAULT_PATH env → obsidian_config.json → cwd/fallback
- 目前 active vault 是 pi-agent-vault，不是 study-news。需要在工具中傳遞 outputPath 或切換 vault。

### Vault 路由現狀（2026-07-10 修復後）

**所有 `obsidian_config.json` 已移除。** 現在 vault 路由由使用者動態控制：

| 層級 | 機制 | 使用方式 |
|------|------|---------|
| Tier 1a | `OB_VAULT_PATH` env | `export OB_VAULT_PATH=/path/to/vault` 啟動 pi |
| Tier 2 | Obsidian app 中開啟的 vault | 在 Obsidian 中開/關 vault，重啟 pi 後跟隨 |
| Tier 3 | `<cwd>/<OB_VAULT_DIR \|\| "vault">` | 無 config 時的零配置 fallback |

**目前 Obsidian app 開啟了兩個 vault：**
- `pi-agent-vault` (`vaults_root/pi-agent-vault/`) — 672 則筆記
- `study-news` (`vaults_root/study-news/`) — AGENTS.md 新聞 vault

**使用建議：**
- 要在 study-news 工作 → 關閉 pi-agent-vault（或設定 `OB_VAULT_PATH`）
- 雙 vault 同時操作 → `write`/`bash` 直接寫入檔案系統

## Resources

- research-tool 套件路徑: `bun-apps/pi-agent-ext-research-tool/`
- study-news vault 路徑: `vaults_root/study-news/`
- 每週新聞目錄: `vaults_root/study-news/weekly-news/`
- 現有範例檔案: `bilibili-llm-2026-07-11.md`, `youtube-llm-2026-07-11.md`

## Environment Status

- YOUTUBE_API_KEY: **not set** → YouTube collection 無法執行
- Bilibili: 無需 API key，但直連有 HTTP 412 風險
- study-news weekly-news/ 目錄已存在，有 11 個週報檔案（含本週 2026-07-11 產出）
- 現有 2026-07-11 檔案可能已過時（created frontmatter 顯示 2026-07-07/08）

## Visual/Browser Findings

<!-- 尚未進行瀏覽器操作 -->
-

## Vault Routing Pattern (fixed bug)

**問題**：`obsidian_append_section` 寫入了 `pi-agent-vault` 而非 `study-news`，因 obsidian_* 工具固定使用 active vault，無法在呼叫時指定目標 vault。

**正確模式**：

| 目標 Vault | 使用工具 | 範例 |
|-----------|---------|------|
| `pi-agent-vault` (active) | `obsidian_*` 工具 | `obsidian_append`, `obsidian_create` |
| `study-news` (或其他 vault) | `write` / `bash cat >>` 直接寫入 | `writeFile('vaults_root/study-news/...')` |

**為什麼不改 config**：
- `obsidian_config.json` 的修改在 session 啟動時快取，mid-session 修改不影響 active vault
- 正確的跨 vault 做法：啟動新 session 時設定 `OB_VAULT_PATH` env
- 單 session 多 vault 操作應使用檔案系統路徑直接寫入

**工作模式**：
```
obsidian_* tools  →  pi-agent-vault  (active vault, 筆記/搜尋/索引)
write / bash      →  study-news     (指定 vaults_root/study-news/ 絕對路徑)
```

## Execution Summary

| Phase | Result | Output |
|-------|--------|--------|
| Phase 1: 環境確認 | ✅ | YOUTUBE_API_KEY missing, Bilibili OK |
| Phase 2: Bilibili LLM | ✅ 40 videos | bilibili-llm-2026-07-11.md |
| Phase 3: Bilibili Media | ✅ 100 videos | bilibili-media-2026-07-11.md |
| Phase 4: YouTube LLM | ❌ 需 YOUTUBE_API_KEY | 跳過 |
| Phase 5: Pi Packages | ✅ 生態研究 | pi-packages-2026-07-11.md (appended) |
| Phase 6: 收尾 | ✅ | All verified |

---
*Update this file after every 2 view/browser/search operations*
