---

# Arc-25 獨立審查報告（Independent Review）

審查範圍：map.md（working tree 版）、`evidence/` 全部 10 個檔案、`arc-ledger.json` entry 25、PR #2277/#2278/#2279/#2280/#2282 的 merge diff、部署目錄 `0.10.3+g9eb78ef`、`~/.pi/subagents/runs/` 三份 run record，以及本機重跑的新測試。

## Verdict: **REQUEST-CHANGES**（3 個 blocker；工程實體本身經得起對抗性查證，close-out 落地後可核可）

---

## 先講經查證屬實的部分（不是 vacuous 的宣稱）

我逐項做了獨立重現，以下宣稱**全部有硬證據支撐**：

| 宣稱 | 獨立查證結果 |
|---|---|
| #2277 升級 29 個 package.json | diff stat 實數 29 檔 + `bun.lock`；`chord@0.85.1` 進、`pi-client`/`pi-protocol` 出 — 與預測逐字吻合 |
| t02/t03/t04/t05 測試可失敗（非 false-green） | `output-cap.test.ts` 邊界矩陣（49K/50K/50K+1、`TAIL` 不可見）、`cwd-delegation.test.ts` 用「工具建構於 A、session 跑在 B、`note.txt` 只存在 B」的互斥 fixture、trust 矩陣 10 案、usage ledger 的 under-report 補償 — 全是真斷言；本機重跑 **3/3 + 22/22 + 511/0 全綠** |
| t06 pre-drive bundle greps | 我在 `0.10.3+g9eb78ef` 上重現：marker 三片段 1/1/1、confirm title 2、deny 1、`fileName` 5、`accrueUsage` 兩 bundle 各 1 — 與 README 表格完全一致 |
| 「bundle 無 grep-able pi 版本字串」 | 屬實：`grep -c "0\.85\.1" s2-agent.js` = 0。map 原訂的 t06 grep 計畫被誠實修正為 chain-of-custody + 行為證明，不是藉口 |
| (d) GLM-5.3、flash by-name 排除 | 三份 run record（`mu1en7sb-r6hfc0` 等）實存且 `model: zai/glm-5.3` |
| 測試數字算術 | 854+8=862 → +10=872 → +4=876；508+3=511 — 全部自洽，`t03-cwd-probe.log` 確為 core-runtime 35 檔 511 案含 3 新測試（log 第 411–413 行） |
| Honesty log（問題 3） | **通過**。Correction #1 對 t04 latent-gate 的描述與 `scenario-c2.log`（evil 確實 RAN，逐字回傳）+ SettingsManager 探測 + blast-radius 分析一致，且從未把 (c) 記為 PASS（PB-15 紀律落實）；Correction #2 的 #2280 slip 在 map/README/next-goal 三處敘述一致。唯一無法驗證的內部細節是「merge CLI 自跑的 fresh green CI」無留存 artifact，屬可接受 |
| Scope（問題 4） | **乾淨**。五個 PR 的檔案全在票面內；#2278 的 `subagent-tool-schema.ts` +9 是 TS interface 欄位 + 註解（非 LLM-visible description，「schema-cost 不變」宣稱成立）；#2280 的 `agent-registry.ts` +3（`fileName`）偏離票面「UNCHANGED」但已在 Shipped-as 披露 |

---

## Blockers

### B1 — Close-out（t07）實際上**沒有落地**；「arc 已關閉」目前不是 durable 狀態

- `git status`（branch `t06-deploy`）：` M .planning/.../map.md`（未 commit）、`?? evidence/deployed-verification/`（**untracked**）— 四份 t06 receipt 現在一個 `git clean` 就會消失，違反該 arc 自訂的 PB-18「committed evidence/ for every verdict」。
- Ledger entry 25：`"status": "active"`、**無 `mergedPr`**（`arc-ledger.json`）。
- 互惠 back-links 不存在：arc-23/24 兩份 map grep `self-arc-25` 零命中。
- 無 `output/LATEST` symlink；無 close-out PR（open PR 僅剩 arc-24 的 #2268）。
- map frontmatter 寫 `status: done / (closed)`、next-goal 寫「receipts committed under evidence/」— 兩者在磁碟上目前皆為**未兌現的現在式**。

**修法**：t07 PR 把 map + receipts + ledger 翻轉（`mergedPr`、status done）+ arc-23/24 back-links 一起落地，validate next-goal → repoint LATEST → effort-audit/doctor。落地後此項撤銷。

### B2 — t01 的 done-when（「smoke receipt under `evidence/`」）從未滿足，且未在 Corrections 披露

- t01 驗收條款明寫：「Done-when: all packages green on 0.85.1, **smoke receipt under `evidence/`**」。
- 實況：#2277 commit 進 `evidence/` 的只有四份研究 digest；「zai/glm-5.3 … live headless smoke green (Bravo851)」**只存在於 PR body 的一行文字** — 既非 committed evidence 也非 merged diff，正是本次審查要抓的 vacuous claim 類型。
- 緩解事實（部分免責）：t06 的 model-call leg + 三份 glm-5.3 run record 事後證明了同一能力。但票面驗收被靜默降級，Corrections 未記。

**修法**：在 close-out PR 補一份可重現的 smoke receipt（source 或 deployed tree 皆可），或在 Corrections 加註 dated correction 明說 done-when 未按原文滿足。

### B3 — D7 承諾的 version bump 在五個 PR 中**全部靜默跳過**

- Map D7 白紙黑字：「Version bump at t01 merge … and again at the LAST implementation PR so the t06 deploy label names the newest bytes」。
- 實況：`bun-apps/s2-agent/package.json` 仍為 `"version": "0.10.3"`；#2277 的 package.json hunk 無 version 行變更，其餘四 PR 根本不碰 package.json。部署標籤 `0.10.3+g9eb78ef` 靠 git 後綴指認 bytes（實質勉強成立），但這是**自我宣告的決策被違反且無 correction 條目** — 與 #2280 slip 該記而記的標準不一致。repo 既有規則（merge 時 version-bump、工具會 nudge）連續 5 次被忽略。

**修法**：close-out PR 補 `version-bump-cli --package s2-agent --patch`，並在 Corrections 加一條 dated 說明（或明文改寫 D7）。

---

## Non-blocking notes（記錄，不擋）

1. **SHA 引用不一致**：map 對 #2277/#2280/#2282 引 merge SHA，但 #2278 引 branch head（`b28fd2f5`，實際 merge `6e88ebf3`）、#2279 引過期 head（`4fc1b15b`，實際 squash `0c86ad35`，多 11 行測試）。「→ amended」有部分披露，仍建議統一引 merge SHA。
2. **scenario (d) 無獨立 log** — 摺進 README header + run-record ID；run record 已驗證屬實，可接受。
3. t03 的「probe first」以 in-CI 測試同 commit 落地（log 為變更後全套綠），PB-10 想像的 pre-change receipt 被測試本身吸收 — 實質成立。
4. Marker 文字說 "bytes" 但量測單位是 UTF-16 code units — 已在 source docstring 披露；deployed 情境為 ASCII 等價。
5. `trustSurfaceFromCtx` 缺 primitive 時 fail-open — 有 header 註解披露為 upstream runner default，且整個 host-latent 問題已在 Correction #1 誠實處置。

---

## 結論

**工程實體：可核可。** 五個 PR 的 diff、測試、部署 receipts、模型政策全數通過獨立重現，honesty log 兩條 correction 忠實且有 artifact 佐證 — 這不是一個漂綠的 arc。

**當前狀態：不可核可。** 「closed」的宣稱與磁碟事實不符（B1），加上兩處未披露的驗收/決策偏差（B2、B3）。三個 blocker 全是 close-out 完成形工作，成本低；B1 落地後我即改判 **APPROVE**。
