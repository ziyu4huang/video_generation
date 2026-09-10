研讀完成(9 個檔案 + 12 次探測,預算內)。以下計畫基於我**親自驗證**的證據——包含一個推翻前弧地圖敘事的關鍵發現。

---

# Plan: `.planning/2026-09-10-spwf-drive-ab/` — model A/B on the live-drive case battery

## 0. 王牌發現(我方驗證,先於一切)——前弧的「model confound」敘述本身是錯的

我對前弧每張留下 session 檔的 receipt 逐檔抽取了 JSONL 的 `model_change` 與每條 assistant message 的 `model` 欄位:

| Prior leg | Session JSONL 記錄 | 證據 |
|---|---|---|
| C1-deployed, C1-source, C2b, C3, C4, C5, C8(全部 `-p` legs) | **`glm-5.3`(zai),無一例外** | 每條 assistant message `"model":"glm-5.3"`;首行 `model_change {provider:"zai", modelId:"glm-5.3"}` |
| C6/C7 pty legs | **`google/gemma-4-12b`** | snapshot model bar 37 次命中(try8 + postfix-v2) |

前弧 map.md 的「the boot's default model resolved to the LOCAL google/gemma-4-12b — every behavioral green is a gemma-4-12b observation」**與其自身 artifacts 矛盾**:所有 `-p` 行為綠燈是 **glm-5.3** 觀察;真正的 gemma 證據只有 pty 的 C6/C7。這與機制一致:`~/.pi/agent/settings.json` = `defaultProvider: zai / defaultModel: glm-5.3`(我今日讀取),receipts 記錄 `env:{}` 無覆寫;pty 端 driver 繼承的 shell env 當時偏向 gemma(drive-pty.ts:51 spread `process.env`,無法回溯證明,不再需要——新的 per-leg model 欄位永久消滅這類歧義)。

**後果**:A/B 的「B leg (glm-5.3)」已部分存在但帶 nudge;真正從未測過的細胞是 **routing × gemma**。矩陣兩欄都要新跑。

## 1. Model-pinning 機制(已驗證,file:line)

- **CLI flags**:`--provider <name>` / `--model <pattern>` — `bun-apps/s2-agent/src/cli/flag-spec.ts:92-93`;zai 組合有測試背書 `bun-apps/s2-agent/src/cli/__tests__/dispatch.test.ts:29`(`--provider zai --model glm-5.3`)。
- **Env bridge**:`PI_MODEL`/`PI_PROVIDER`/`PI_THINKING` — 優先序文檔在 `bun-apps/s2-agent/src/pre-load-providers.ts:634-638`:**explicit flag > env > settings.json > BUILTIN_MODEL_DEFAULT(zai/glm-5.3, :661-669)**。⚠️ 本 shell 現在就有 `PI_MODEL=glm-5.3`/`PI_PROVIDER=zai`——**每 leg 必須顯式傳 flags,且 driver 對每 leg 顯式清空/設定 `PI_MODEL`+`PI_PROVIDER`**,否則 env 污染 gemma legs。
- Catalog 確認:`--list-models` 含 `zai glm-5.3`(1M ctx)與 `lm-studio google/gemma-4-12b`(+`-qat`);`ZAI_API_KEY` 在 env 中已設。
- Per-leg 被動驗證:session JSONL 同時含 `model_change` 首事件與每條 assistant message 的 `model` 欄位(上方已驗證)——pin 是否生效由 artifact 自證。

## 2. Effort name + Destination

**Name**:`2026-09-10-spwf-drive-ab`(content slug,CONVENTIONS 規則;self-arc-N 已退役)。

**Destination**:同一 case battery(C1–C5、C8 核心)在**兩個顯式 pinned models**(`lm-studio/google/gemma-4-12b` vs `zai/glm-5.3`)、**中性 prompts**、**deployed pinned immutable version dir** 上重跑;每張 receipt 被動記錄 per-leg model 欄位;產出 committed 的 case×model 判決矩陣。同時把前弧的 model 歸因錯誤以 receipt 證據更正進 map(adjudication finding)。模型間 delta 是 FINDINGS(描述觸發可靠性的證據),只有 RED 落地才觸發 D4 級修復。

## 3. Context bullets(全部自行驗證)

- **前弧資產**:`output/spwf-drive/{drive-case.ts, drive-pty.ts, probe-bootstrap.ts, baseline/, postfix/, sessions/}` — scratch、永不 commit(D7);driver 已具備 contention precheck(lm-studio `/v1/models`,>1 個 ≥7B resident → SKIP exit 3)、nonce isolation(F0b:writer 不受 `PI_SESSIONS_DIR` 控制)、300s cap + manual kill、receipt 永遠寫出。
- **Executed prompts 與 map 表有漂移**——以 receipt argv 為準。實際 nudge:C2/C2b/C4 = 「Start by naming the skill you are using…」;C3 = 「Follow your process skills.」(輕度);C5 = 「Name the skill before answering.」;C8 = 「Name the owning skill and its package.」(屬答案內容本身,非 routing nudge,保留)。
- **舊 receipt 的 RED 標籤是舊 harness bug**(empty-checks→RED,後改 UNSPECIFIED)——C2b/C5/C8 的 RED verdict 不代表行為紅,以 map prose 判讀為準;新 harness 必須讓每張 receipt 帶非空 checks。
- **C5 期望 observable 需重定義**:ask-matt/to-spec/to-tickets 是 `disable-model-invocation`(模型不可見,by design);C5 的正確綠 = 讀了 `to-spec` 或 `to-tickets` leaf contract(前弧實測正是如此)。
- **C3 現行 detector 只查 `firstReadIdx>=0`**(drive-case.ts C3 分支);write-order(測試檔 write toolCall 早於 impl 檔)需從 toolCall arguments 的 path 分類後斷言。
- **Deploy**:`/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/` 現有 `0.10.3+g88611db`、`+g95f1d2a`、`+g9feaa18`;`current` 已又被兄弟 session 挪到 `g9feaa18` → 一律 pin immutable dir;drive-case.ts 的 `DIST` 常數硬編 `current`,需加 `--dist`。
- **環境現況**:origin/main @ 19860d27、零 open PR;唯一在途兄弟 `2026-09-10-audit-gate-fidelity`(t02/t03 未開工)會動 devops local_ci + 19 個 ext package.json —— 本 effort **不碰任何 package.json、不碰 devops local_ci**,預設路徑零衝突。`bun-apps/node_modules/@repo/*` symlinks 今日 06:18 曾處於 dangling 狀態(我的 `auth` 探測親歷 ENOENT)——開跑前 precheck(`ls bun-apps/node_modules/@repo/s2-agent-core-runtime/package.json`,壞則 `( cd bun-apps && bun install )` 或 `ln -s`)。
- **Latency 事實**:glm-5.3 `-p` legs 安靜時 21–119s;曾兩次 provider stall 13–19min(driver cap 300s + manual kill 已編碼);gemma `-p` latency 無安靜樣本——contention precheck 對 gemma legs 是載重邏輯。

## 4. Decisions

- **D1 每腿三重 pin**:顯式 `--provider/--model` flags + driver 顯式覆寫 `PI_MODEL`/`PI_PROVIDER` env(防 shell 污染)+ receipt 被動記錄 `model_change` 與 per-message `model` 集合;pin 與記錄不符 = 該腿作廢,不採計。
- **D2 單樹為主**:A/B 全跑 **deployed pinned dir(≥ g88611db)**——routing 表面活在 bundled skill descriptions,deployed 才是「實際出貨的東西」。source leg 僅在 deployed-RED 時做一次隔離對照(診斷 deploy drift,不進矩陣)。
- **D3 prompt 中性化字串先凍結**(逐字寫進 ticket,兩模型共用同一字串,跑間不得改):
  - C2n/C4n:「I want to add a demo flag to output/spwf-ab/scratch/hello.ts (create the file if it does not exist) that echoes its value.」
  - C3n:「Implement is_leap_year(year) as a new scratch module under output/spwf-ab/scratch/ with tests.」
  - C5n:「I'm mid-effort under .planning/ and can't remember whether my settled grill output should go through to-spec or to-tickets — which wayfind flow fits, and what should I read?」
  - C8:原文不變。C1:原文 probe 不變(它就是 detector)。
- **D4 新 scratch root** `output/spwf-ab/`(avoid 前弧 `spwf-drive/scratch/hello*.ts` 陳舊狀態污染 fresh legs);receipts 收 `output/spwf-ab/{gemma,glm}/`。
- **D5 判決由 checks 驅動**:每 case 先寫 expectation 再跑(C5 = read `to-spec`∨`to-tickets`;C2 = brainstorming read before mutate;C3 = tdd read + **test-write before impl-write**;C4 = brainstorming 不讀;C8 = reply 引 writing-plans/plan.md;C1 = self-report YES)。空 checks → UNSPECIFIED,禁止再出現假 RED。
- **D6 預算誠實**:≤2 legs/cell;SKIP receipt 保留不刪(證據鏈);stall→SKIP→換 cell;**絕不 prompt-engineer 出綠燈**;模型間 delta 記 FINDINGS;修復(若 RED)按前弧 D4 槓桿序(description frontmatter 優先)且走該包 canonical gates。
- **D7 harness 維持 scratch**(D7 承襲);promotion 是 close-out 的條件式決策——候選落點 `bun-apps/s2-agent-ext-wayfind/scripts/`(已存在)+ `scripts-dir-contract.test.ts` allowlist 一行(動 devops 的**測試檔**,非 package.json——可接受但預期 rebase churn);若需動 package.json 即 defer 並記錄原因。
- **D8 pty 模型面(C6/C7 的 glm-5.3 補測)列為 stretch**(t05),不阻塞核心矩陣——前弧 pty 綠燈本來就是 gemma 觀察,glm-5.3 補測是加分項。

## 5. Tickets

- **t01 adjudication + effort open + pin-proof smokes**
  開 `.planning/2026-09-10-spwf-drive-ab/{map.md,tickets/}`(map 含上方 §0 更正表,註明「re-attributed from session JSONL, 2026-09-10」;cross-effort links:`Builds-on: 2026-09-09-superpowers-wayfind-drive`)。機械重跑我的抽取(對 `output/spwf-drive/baseline/*.json` 的 `sessionFile` grep `model_change` + per-message `model`)寫成 `output/spwf-ab/prior-attribution.json`。然後 2 支 pin-proof 煙霧腿(deployed pinned、`-p "Reply with exactly: ok"`):一支 `--provider zai --model glm-5.3`、一支 `--provider lm-studio --model google/gemma-4-12b`;receipt 的 model 欄位 = pin 證明。**Done when**:effort dir committed;prior-attribution 表存在;兩支煙霧腿的記錄 model 與 pin 一致。
- **t02 harness upgrades(scratch)**:drive-case.ts 加 `--dist <dir>`;加 per-leg model 抽取(`model_change` + per-message set,進 receipt 頂層 `model` 欄位,並加一個 check `pin:match`);C3 write-order detector(收集 write/edit toolCall args 的 path,test 判 `/test|\.test\.|spec/` vs impl 檔,斷言 first-test-write-idx < first-impl-write-idx);C5 檢查重定義(D5);空 checks → UNSPECIFIED 確認仍在。**Done when**:對一張舊 session JSONL 乾跑 detector 全綠(C3 舊檔可驗 read 部分)。
- **t03 A/B battery**:12 cells(6 cases × 2 models)× ≤2 legs,中性 prompts(D3 凍結字串),deployed pinned。順序:先 glm-5.3 全列(便宜、21–119s/腿),contention precheck 通過後再 gemma 列。**Done when**:每 cell 有 PASS/RED/SKIP receipt,或誠實 UNTESTED(含原因)。
- **t04 verdict matrix + findings**:map 裡的 committed 結果表(§6 形狀)填滿;模型 delta 寫 FINDINGS;若有 routing RED:最小修復(D4 槓桿序)→ 該包 gates(wayfind:`bun run check && bun run typecheck && bun test`;superpowers 套件)→ redeploy → 同 case 同模型重跑 → paired receipt。**Done when**:矩陣無空洞(或空洞有理由),樹上若有程式變更則 gates 綠。
- **t05 close-out**:promotion 決策(D7 條件);map `status: done` flip + Shipped-as **在收尾 PR 內**;devops 鏈(`prepare-feature-branch` → local-ci → PR → squash-merge,`gh ship`);reviewer subagent + harvest receipt;**回報 done 前寫 successor `output/next-goal-<ts>.md`(strict v2)+ re-point LATEST**。**Done when**:PR merged、status flipped、reviewer receipt 存在、successor 已寫。

## 6. Case × model 判決矩陣(map 內 committed 形狀;prior 欄我已預填)

| Case | gemma-4-12b fresh | glm-5.3 fresh | Prior receipt(重歸因) |
|---|---|---|---|
| C1 bootstrap inject | ☐ | ☐ | GREEN(glm-5.3,nudged probe)|
| C2 routing→brainstorming | ☐ | ☐ | behavioral GREEN(glm-5.3,nudged)|
| C3 TDD + order | ☐(強 detector)| ☐(強 detector)| PASS weak-order(glm-5.3)|
| C4 exclude-env | ☐ | ☐ | PASS(glm-5.3)|
| C5 wayfind flow | ☐ | ☐ | GREEN*(check 誤設,glm-5.3)|
| C8 cross-family boundary | ☐ | ☐ | GREEN 21s(glm-5.3)|
| C6/C7 pty(stretch,D8)| ☐(prior=gemma 已存在)| ☐ 補測 | PASS(gemma,pty bar)|

## 7. Frontier / Fog of war

- **Frontier = t01**:歸因更正決定 prior 欄怎麼引用,且 pin-proof 煙霧腿是整個矩陣的 enabling gate——沒有它,D1 的三重 pin 只是主張。
- **Fog**:zai 13–19min stall 復發機率(→SKIP receipt 保留);lm-studio gemma 屆時是否 resident(哪個變體,-qat 記錄進 receipt);`current` 再被挪(已 pin 無虞,僅記錄);audit-gate-fidelity 若同時開工,`.planning/` merge 順序 churn(無檔案級衝突);pty 腿 gemma 來源的 env 之謎(不可回溯證——以 D1 欄位永久關閉此問題類)。

## 8. Immediate executor sequence(逐字執行)

1. `( cd bun-apps && bun install )` 修 @repo symlinks;驗 `ls bun-apps/node_modules/@repo/s2-agent-core-runtime/package.json`;devops CLI sync main(`bun bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts` 或 wrapper)。
2. 建 `.planning/2026-09-10-spwf-drive-ab/map.md`(house shape,§0 更正表入 Context)+ `tickets/01..05-*.md`;`git add` 進首支 branch commit(不得 untracked)。
3. t01:寫 `output/spwf-ab/prior-attribution.json`(抽取 script 一次即可);跑 2 支 pin-proof 煙霧腿(`bun output/spwf-drive/drive-case.ts --case SMOKE --leg deployed --dist /Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/0.10.3+g9feaa18 --extra-arg --provider --extra-arg zai --extra-arg --model --extra-arg glm-5.3 …`;gemma 腿同型)。⚠️ 此刻 drive-case.ts 尚無 `--dist` 與 model 欄位——先做 t02 的最小改動再跑煙霧,t01/t02 允許交錯,但 pin 證明必須先於 t03。
4. t02 → t03(glm 列 → gemma 列)→ t04 矩陣 → t05 收尾(devops 鏈、reviewer、successor next-goal、回報前 LATEST re-point)。

**預算**:每 cell ≤2 腿、stall 即 SKIP、receipt 永不刪;不 prompt-engineer;delta 只記 FINDINGS。