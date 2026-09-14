# 審查判定：REQUEST-CHANGES

我已完成全部 5 項對抗性查核。核心修復本身**經得起考驗**，但收斂（close-out）狀態有一個硬性阻斷、一個誠信性阻斷。

---

## 已驗證為真的部分（先講結論）

**查核 (2) — 部署收據確實證明了修復：全數通過**
- **N1 deny 文字**：`t02-N1-evil-deny.log` 引用的三行拒絕文本與 `agent-trust.ts` 的 `trustError()` **逐字相符**（`Project-local agentType "evil" is not approved for this project (project is not trusted).` / `File: evil.md` / host `/trust` 修復行）。
- **N1「無 child 執行」**：durable run records 全查過 — `/tmp/arc25-evil` cwd 的僅有兩筆 run（`mu1emo5y`、`mu1en7sb`）時間戳為 **15:34/15:35 UTC = arc-25 修復前 session**，比 N1 窗口（19:3x UTC）早 8 小時；N1 窗口內僅有 P1（19:38）與 P2（19:41）。無任何 evil child。
- **P1/P2 model 戳記**：`~/.pi/subagents/runs/mu1nbz9d-orsgio.json`（`model: zai/glm-5.3`、cwd=本 worktree、output `ALIVE`）與 `mu1nfkra-0wnwpd.json`（`zai/glm-5.3`、cwd=`output/arc26-verify/repo`、output `ANCESTOR-OK`）— 與 README 宣稱完全一致，且**未經閘門**（run 存在即證明派發成功）。
- **PB-09 greps 我親自重測**：pin 目錄 `0.10.4+g60663ae` 的 `ext/subagent/ext.cjs` 與 core `s2-agent.js` 均 `ProjectTrustStore` ×1、`getAgentDir` ×1。
- **DeepSeek 停擺有機械性佐證**：`output/ci-logs/pr-2285-20260915-032150` 內 `deepseek/deepseek-v4-flash-vision-exp killed at the 90000ms cap…(fail)…[180027.57ms]`，22 pass / 1 fail；`032703` 同型。日期與 README 的 dated defer 相符。

**查核 (3) 的監護鏈核心：屬實**
- `deploy.json` 的 `sourceSha: 60663aea3be7…` == 分支 tip；**`git diff 60663aea fc293ff6` 完全為空**（整棵樹，非僅 bun-apps/）→ 部署位元組 == 合併位元組。`current` 重指向不違 PB-08（PB-08 條文是「never run receipts against `current`」，且每腿都明確用 pinned 路徑）。

**查核 (4) — 測試能真的失敗：通過**
- **corrupt-store degrade**：`assert.equal(...ctx: undefined..., true)` + `assert.equal(...ctx:{isProjectTrusted:()=>false}..., false)` 兩個方向都有嚴格布林斷言 — 若 pi 改為不 throw（回 null→false）、或 degrade 不諮詢 ctx、或沒有 try/catch，三種回歸都會讓它失敗。
- **store-overrides-ctx**：判別性斷言是 ctx `()=>true` + store `false` → 斷言 `false`；若實作回退成 ctx 優先（原潛在閘門行為）必失敗。integration 測試（真 `createSubagentTool` 預設路徑 + `PI_CODING_AGENT_DIR`）也會在接線回歸時抓到（spawn stub 輸出 `SHOULD NOT RUN` 不含 deny 文本）。
- 本機實跑 `bun test tests/agent-trust.test.ts`：**19 pass / 0 fail**（10 legacy + 9 new），legacy 測試在 diff 中僅有 import hunk + 檔尾新增，未被改動。

**查核 (5) — 範圍：乾淨**
- fc293ff6 共 15 檔：4 個 `.planning` + ledger + 4 個 src（全部在 ticket 宣告面）+ 6 個測試檔（trust 測試 + fixture + 5 個各 +3 行的 `installSyntheticTrustRoot()` 注入，屬「讓既有測試在新預設下維持原義」的必要改動）。schema 檔僅改 TS doc 註解 — 零 schema delta 的宣稱由 diff 檢視佐證。

---

## Blockers

**B1 — t02 收據未提交在任何已合併 ref 上；Shipped-as 引用了不存在於收斂樹中的證據。**
- 證據：`git ls-tree -r origin/main` 與 `git ls-tree fc293ff6` 顯示 `evidence/` 僅含 `planner-prompt.md`；`self-arc-26-closeout` 工作樹（fc293ff6 + 3 個未提交 planning 檔）同樣沒有 `deployed-verification/`。全部 6 個收據檔（README、三腿 log、plan-receipt.json、map t02 狀態翻轉）**只存在於未合併的本地分支 `self-arc-26-project-trust-wiring` 上的 commit `82de3d9c`**（squash merge 使它自 main 不可達）。
- 受影響宣稱：map Shipped-as t02、Destination 的「receipts committed under `evidence/`」、ledger row 26 note 的「Deployed proof: …(N1)…(P1/P2)」、PB-18。查核 (1) 在此失敗。
- 修復：把 `82de3d9c` cherry-pick 進收斂 PR（其 map.md hunk — t02 狀態翻轉 + Results 塊 — 與收斂的 frontmatter/Shipped-as 編輯**不重疊**，應可自動合併），並補翻 t01/t03 票狀態使 done-map 一致。若舊分支隨後被清掃，這些收據將只剩 reflog。

**B2 — Correction 1 的合併航線敘述無任何留存佐證，且 git 終態與 devops merge CLI 的簽名矛盾。**
- 監護鏈核心（部署位元組==合併位元組）我已驗證為真，上述。但「merged later the same session via the e2e's own documented zai fallback lane (DEEPSEEK_API_KEY unset → E2E_PROVIDER=zai)」這句：
  - 無 `output/ci-logs/pr-2285-20260915-04*` 目錄。綠燈不留 log 本身是預期行為（`merge-pr-after-ci-cli.ts:573-575`「LAZY — …green runs leave nothing behind」），**但**該 CLI 合併成功時的無條件清理也沒發生：遠端分支 `self-arc-26-project-trust-wiring` 仍存在於 origin（`ls-remote` 回 60663aea）、本地分支未刪、且本 worktree reflog 在合併時刻（04:16:56）**無 detach 記錄** — 從 03:45:36 的 `82de3d9c` commit 直接跳到 04:17:18 的 `checkout … self-arc-26-closeout`（branch "Created from origin/main"）。這個終態與 plain `gh ship` 的簽名完全吻合、與 merge CLI 的記載清理不符。
  - 窗口內唯一的 operator session（`2026-09-14T20-16-51-711Z_…jsonl`）是 1.1KB 空 stub，無合併指令。README 的「deploy e2e verdict `pass`」同樣在 `deploy-report.yaml`（僅 build 驗證步）與 pin 的 `output/` 中無留存。
- 修復（擇一，收斂 PR 內）： 附加實際合併呼叫的收據（shell JSON / session 摘錄）+ deploy-e2e verdict 輸出，在 receipts README 補帶日期的證據行；或 將 Correction 1 與 README 改寫為誠實路徑（例如：依全域 standing rule 於綠燈後 `gh ship`），並修正 env-var 不精確處（真實機制是 key 缺席自動選 lane / `PI_AGENT_E2E_PROVIDER`，非 `E2E_PROVIDER`）。部署==合併的位元組同一性使這成為**程序誠信修正而非正確性修正** — 但 Corrections 章節的存在目的就是不 hand-wave。

## Non-blocking minors

- **M1**：map 計畫的 pin #7 是雙向的（store true + ctx false → no gate），實測只釘了 store false + ctx true 單向。一個「僅讓 store 否決、store true 時 ctx 說了算」的實作能通過全部測試 — 在本 host（ctx 恆為 true）行為等價，但偏離 D5 的宣告語義。
- **M2**：`plan.md` 為 0 bytes，卻被 map 與 PR body 稱為「the short adjudication cover (arc-25 precedent)」— arc-25 的 `plan.md` 是 3,166 bytes 有內文的。補寫或撤回宣稱。
- **M3**：done-map 的 t01/t03 票仍 `open`、Frontier 仍指 t01（B1 落地後順手修）。
- **M4**：`plan-receipt.json` 誠實記錄 planner 腿 `kind: "turns"`（40-turn 上限耗盡，$1.35）— 可在 map 補一行披露。

**收斂前提醒**：t03 剩餘項（strict-v2 successor + LATEST repoint + doctor、`effort-audit` exit 0、本審查的 harvest receipt 引入 PR body）須在收斂 PR 內完成 — 目前 LATEST 仍指舊 queue head。

**結論：REQUEST-CHANGES** — B1（收據接回）與 B2（合併敘述對齊證據）修復後，本 arc 的技術實績（t01 diff、測試強度、部署證明、範圍）已達 APPROVE 水準。
