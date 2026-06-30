# `.pi/` 目錄說明與踩坑筆記

這個目錄是 pi-coding-agent 在**專案層級**產生的設定/狀態目錄。

## ⚠️ 最重要的坑:這裡的 `models.json` 不會被讀取

pi 的 `models.json`(自訂模型/providers,例如 LM Studio、Ollama)是**全域設定**,
pi 只讀這個路徑:

```
~/.pi/agent/models.json          ← pi 實際讀取的位置(全域)
```

而**不是**這個目錄裡的:

```
.pi/agent/models.json            ← 放這裡 pi 完全不會讀!
```

### 症狀

- 在 `.pi/agent/models.json` 設好 LM Studio 的 provider 與模型。
- 設定內容完全正確(`baseUrl`、`api`、`apiKey` 都齊全)。
- 開 `/model` 卻看不到任何自訂模型,且**沒有任何錯誤提示**。

### 原因

這個 `.pi/agent/` 目錄是 pi 在專案裡自動產生的(用來放 `trust.json`、
`settings.json`、`auth.json`、`sessions/`),所以很容易讓人誤以為
所有設定檔都可以放這裡。但 `models.json`、`themes/`、`bin/`、`prompts/`
這些都是**全域**設定,pi 只會從 `~/.pi/agent/` 讀取。

### 修正方式

把檔案搬到家目錄:

```bash
cp .pi/agent/models.json ~/.pi/agent/models.json
```

搬完後重新打開 `/model` 即可(設定檔每次開啟 `/model` 都會重新載入,不用重啟 pi)。

> 對 LM Studio 這類本地伺服器,provider 的 `apiKey` 填一個字面值(dummy)
> 即可,pi 會當作「已設定驗證」,模型就會出現在 `/model`,不需要再 `/login`。

## 這個目錄裡實際會用到的檔案(專案層級)

| 檔案/目錄 | 用途 |
|-----------|------|
| `trust.json` | 該專案的信任設定 |
| `settings.json` | 該專案的設定 |
| `auth.json` | 該專案的驗證 |
| `sessions/` | 該專案的對話歷史(實際存放在 `~/.pi/agent/sessions/`,這裡不放) |

## 能不能強制讓 pi 讀別的路徑?

可以,但只能**整個目錄**一起換,無法只覆寫 `models.json`:

```bash
export PI_CODING_AGENT_DIR=/path/to/custom/agent-dir
# 或臨時使用:
PI_CODING_AGENT_DIR=./.pi/agent pi
```

設了之後,pi 會把 `models.json`、`auth.json`、`settings.json`、`sessions/`、
`themes/` 全部改到那個目錄。如果你只想要專案專屬的模型清單,這個方式代價
偏高(session/auth 也會被切換)。**目前 pi 沒有「只覆寫 models.json」的機制**,
這算是一個限制。

## 已啟用的專案層級套件 (`settings.json` → `packages`)

| 套件 | 來源 | 需要的環境變數 |
|------|------|----------------|
| `pi-obsidian` | `../packages/pi-obsidian` | （選用）`OB_VAULT_PATH` / `OB_VAULT_DIR` |
| `zai-mcp` | `../packages/zai-mcp` | **`ZAI_API_KEY`**（必要；未設時套件優雅降級，跳過所有 Z.ai MCP server） |
| `rpiv-todo` | `npm:@juicesharp/rpiv-todo` | — |

### ⚠️ `zai-mcp` 的 `ZAI_API_KEY`

- **只在環境變數提供**，絕不寫進本目錄任何檔案（`auth.json`、`settings.json`、`README` 都不存 token）。
- 設法：

  ```bash
  export ZAI_API_KEY=...        # 放 ~/.zshrc / shell rc，或 CI secret
  ```

- 缺它時 `zai-mcp` 會 `notify("warning")` 並跳過註冊所有工具（session 不會中斷）。

## 結論

- 自訂模型一律放 `~/.pi/agent/models.json`。
- 不要放 `.pi/agent/models.json`(這裡只有 trust / settings / auth 是有效的)。
- token / API key 一律走環境變數，不要寫進 `.pi/` 任何檔案。
