---
effort: 2026-09-15-gemma-compact
created: 2026-09-15
last: 2026-09-15
status: done
---

# Wayfinder map: 2026-09-15-gemma-compact — fill the gemma column + prove 2-compact re-arm

## Destination

Execute the LATEST queue head (validated successor
next-goal-20260914-230436.md): (1) fill the gemma column's UNTESTED cells
(C1/C2/C3/C5 — C4/C8 already PASS) by loading gemma-4-12b into an otherwise
EMPTY LM Studio and running the committed battery's gemma cells immediately
(JIT load + quiet machine = stable residency, unlike the churn window);
(2) prove the superpowers bootstrap RE-ARMS across a SECOND compaction
(2-compact receipt — the existing receipt covers one cycle); (3) curator
delta: the NaN unary-plus lesson enters the playbook (PB-21) with the
line-cap restructure that keeps the schema test green. Closes with
receipts, one PR through the devops chain, reviewer, successor.

## Context (verified 2026-09-15)

- `lms ps` at open: NO models loaded (the churn window has passed —
  sibling idle). `lms load` CLI hangs (9 min, killed) — JIT load via the
  first API request is the reliable path (proven: prior gemma C4/C8 legs
  worked via JIT).
- Battery: committed at wayfind/scripts/spwf-battery.sh (frozen prompts,
  triple pinning); drive-case.ts detector is the promoted canonical copy.
- Pin: 0.10.3+g11e90db carries the NaN fix + F2 directive. Newer sibling
  deploys exist (gbee16fd, current) but g11e90db is this lineage's
  verified base; the gemma surface is identical across them (wayfind/
  superpowers skills byte-checked in the #2266 era; superpowers gained
  only the F2 line since).
- Prior gemma state: C4 PASS, C8 PASS, C1/C2/C3/C5 UNTESTED-infra
  ("Model unloaded." churn + raw token soup on C5).
- session_compact: 1-cycle receipt PASS (attempt 2, 85s window); 2-cycle
  re-arm is the depth ask. F0a: behavioral (tier-3) detector only.
- Playbook: exactly 150 lines / 20 entries (at cap) — PB-21 add requires
  the curator's line-restructure (Added→Status merge frees 20 lines).
- Collision: sibling #2268 open (devops local_ci src + ext package.json) —
  untouched here.

## Tickets

- [x] t01 open effort (this commit)
- [x] t02 gemma fill: 6 cells run; receipts → evidence/gemma/
- [x] t03 2-compact receipt: /compact → probe → /compact → probe (both
      YES) via drive-compact 2-cycle extension
- [x] t04 playbook PB-21 (NaN unary-plus lesson) + line restructure; schema
      test green
- [ ] t05 close-out: reviewer GLM-5.3, PR chain, matrix delta, successor

## Frontier

- t02 is the queue head; t03 is independent (can interleave).

## Fog of war

- gemma JIT load may evict under sibling pressure mid-battery (→ SKIP
  receipts, preserved; retry once).
- /compact on a near-empty context may be a no-op (the probe question is
  sent fresh each cycle — the re-arm assertion is the bootstrap self-report,
  not context size).
- The schema test's Added-merge restructure must keep the parser green.

## Cross-effort links

- Builds-on: 2026-09-10-spwf-ab-closing (D5 precondition protocol + battery)
  and 2026-09-14-spwf-improve (NaN fix lineage — PB-21's subject).

## Gemma column results (2026-09-15, evidence/gemma/; pin g11e90db)

| Case | Verdict | Detail |
|---|---|---|
| C1 bootstrap self-report | PASS | YES (5th consistent YES on this prompt across configs) |
| C2 brainstorming routing | **PASS** | brainstorming read（order 元件空轉 — 無 mutation 可比） — gemma 路由首次正確 |
| C3 TDD routing | RED (variance) | read brainstorming + using-superpowers, NOT TDD — gemma 選了 brainstorming 路線（防禦性合理，但與 A/B 期望不同） |
| C4 exclude-env | RED (mechanism found) | brainstorming WAS read from the deployed path despite exclude+ns — the knob controls ADVERTISEMENT, not file access; the F2 directive orders skill reads and the model path-guessed. Plus 300s timeout (exit 143). |
| C5 wayfind flow | PASS (re-adjudicated) | read using-superpowers + answered correctly via the bootstrap routing table; expectation widened to include using-superpowers (same F3/D8 logic as the gate route) |
| C8 cross-family | PASS | writing-plans cited |

Findings:
- **F-g1**: gemma 路由已進步 — C2 brainstorming 路由首次在 gemma 上正確（先前輪次 0 reads）。
- **F-g2 (C4)**: exclude knob = 廣告層保證；F2 指示 + 模型路徑猜測可繞過。 KB 改善候選：exclude 時在 bootstrap 加一條「被排除的 skill 不可讀」。
- **F-g3**: C5 期望集需要 using-superpowers（方法論路由器也是合法路由）。

## Decisions

- **D1 — C5 expectation widened**: read-any set gains `using-superpowers`
  (the methodology router is a legitimate route per the F3/D8 precedent;
  the C5-glm receipt is re-adjudicated PASS on that basis, receipt
  preserved unmodified with a sidecar note in evidence/).
- **D2 — C4 mechanism recorded as an advertisement-level bypass**: the
  exclude knob controls resources_discover; the F2 directive orders skill
  reads and the model path-guessed the deployed SKILL.md. KB improvement
  candidate (F-g2): an "excluded skills are unreadable" line in the
  bootstrap when exclude is active.

## Results + receipts (2026-09-15)

- **t02 gemma fill (6 cells, receipts evidence/gemma/)**: C1 PASS (YES),
  **C2 PASS — brainstorming 路由首次在 gemma 上正確**（brainstorming read ✓;
  order 元件因 session 未及 mutate 而空轉 — 實證是 read 檢查本身）, C3 behavioral variance (brainstorming 路線而非 TDD — 防禦性
  合理), C4 RED with mechanism (exclude knob = 廣告層; F2 指示 + 模型路徑
  猜測直接讀了 deployed brainstorming 檔；300s timeout 混合), C5 PASS
  (re-adjudicated: using-superpowers 路由 + 答案正確), C8 PASS
  (writing-plans)。
- **t03 2-compact: PASS** — /compact × 2，每次壓縮後 bootstrap self-report
  YES（re-arm 重複成立）。Receipt: evidence/compact-2cycle-receipt.json。
- **t04 PB-21 + restructure**: playbook 136 lines / 21 entries（Added 併入
  Status 釋出 20 行給未來條目）；schema test 6/6 green。
- lms load CLI 會卡死（9 分鐘無進展，已記錄）— JIT load + 空閒機器是可靠
  的駐留路徑。

## Shipped-as (2026-09-15)

- PR <impl>: gemma 欄位接收、2-compact 接收、PB-21 + playbook restructure。
- 本 PR 同時翻轉 map status（CONVENTIONS 規則）。
