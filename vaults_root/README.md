# vaults_root/

Multi-vault 佈局的根目錄。每個子資料夾是一個獨立的 Obsidian vault（各自的
`.obsidian/`、`Design/`、`Inbox/`、`Zettelkasten/` …），方便同一個 monorepo
管理多套知識庫。本目錄鏡像 `ziyu4huang/pi-agent` repo 的 `vaults_root/` 版面。

## 結構

```
vaults_root/
├── README.md                  ← 本檔，本 repo 追蹤
├── pi-agent-vault/            ← git submodule → ziyu4huang/pi-agent-vault.git
│   ├── Design/
│   ├── Inbox/
│   ├── Zettelkasten/
│   ├── Tags/
│   └── .obsidian/
└── study-news/                ← git submodule → ziyu4huang/study-news.git
```

## 子 vault 一覽

| 資料夾 | 來源 | pin（commit） | 說明 |
|--------|------|---------------|------|
| `pi-agent-vault/` | `git@github.com:ziyu4huang/pi-agent-vault.git` (submodule) | `53febc7`（origin/main latest, 2026-06-27） | pi-agent 專案的主力知識庫；`bun-apps/pi-obsidian` 增強計畫的學習來源與目標驗證場域 |
| `study-news/` | `git@github.com:ziyu4huang/study-news.git` (submodule) | `2d436daf`（origin/main latest, 2026-07-05） | LLM + Zettelkasten 敏捷知識圖譜開源專案研究（private） |

## 為什麼是 submodule

`pi-agent-vault` 是獨立 git repo，以 **submodule** 形式掛載。本 repo 只記錄
其 **pin（commit SHA）**，不追蹤其內部檔案。換掛載點只改 `.gitmodules` 的
`path`，**不會動到 pin 或子 repo 內容**——所以原本的 wiki-link 相對路徑、
Obsidian 設定全部保留。

## 讓 `pi-obsidian` / `pi-agent cli` 指向這裡

`bun-apps/pi-obsidian` 的 obsidian 工具預設讀 `<cwd>/vault/`（給任意專案用的
通用預設，**不應**改成 repo 專屬路徑）。本 repo 改用環境變數 / flag 指向：

```bash
# 絕對路徑（最明確）
export OB_VAULT_PATH="$PWD/vaults_root/pi-agent-vault"

# 或 CLI flag
--vault "$PWD/vaults_root/pi-agent-vault"
--vault-dir vaults_root/pi-agent-vault
```

## 操作

```bash
# 初始化 / 同步 submodule
git submodule update --init --recursive vaults_root/pi-agent-vault

# 更新 pin 到子 repo 最新 commit
git -C vaults_root/pi-agent-vault fetch origin
git -C vaults_root/pi-agent-vault checkout origin/main
git add vaults_root/pi-agent-vault   # 父 repo 記錄新 pin SHA
```

## 新增另一個 vault

1. 若是獨立 repo：`git submodule add <url> vaults_root/<name>`
2. 若只是本機資料夾：直接 `mkdir vaults_root/<name>`，Obsidian 開它即可。
3. 更新上方「子 vault 一覽」表格。
