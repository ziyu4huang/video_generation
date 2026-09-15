---
effort: 2026-09-15-spwf-c4-excluded-unreadable
created: 2026-09-15
last: 2026-09-15
status: active
---

# Wayfinder map: 2026-09-15-spwf-c4-excluded-unreadable — excluded skills are UNREADABLE (bootstrap line + paired receipt)

## Destination

Mini-arc (planner-led, GLM-5.3 playbook-included; receipt
output/c4kb-plan/plan-receipt.json): land the C4 KB candidate — when
env-derived skill exclusions are active, the injected bootstrap tells the
model the excluded skills are UNREADABLE (do not read; do not path-guess;
override clause for the F2 paragraph that names brainstorming). Paired C4
receipt: PRE exists (gemma path-guessed the excluded brainstorming and read
it — evidence/c4/pre.json, RED); POST on a new immutable deploy must show
`forbid:brainstorming` PASS. Merged with map terminal + receipts committed.

## Context (planner-verified, file:line)

- Mechanism: the exclude knob (PI_SUPERPOWERS_SKILL_EXCLUDE →
  resources_discover → resolveAdvertisedSkillPaths, superpowers.ts:181/226)
  controls ADVERTISEMENT only; reads were never constrained. PRE receipt:
  gemma ran `ls -R | grep -i brainstorming` (msgLine 11) then read the
  guessed deployed path (msgLine 15) — steered by the F2 paragraph that
  names brainstorming unconditionally (superpowers.ts:283).
- Bootstrap builder: getBootstrapContent (superpowers.ts:270), cached once
  per process; parseSkillExclude (:137) merges defaults ∪ env with `!`
  reset sugar; listSkillDirNames (:156) available for intersection.
- Detector constraint: context-event injection does NOT persist to session
  JSONL (F0a) — the POST receipt is behavioral (forbid:brainstorming) +
  bundle byte-verify (PB-09 sentinel grep), tier-3 self-report optional.
- Tests: bootstrap.test.ts has a TOKEN BUDGET RATCHET ≤5,900 chars running
  WITHOUT env → a conditional line cannot regress it.
- Collision: sibling PR #2268 (devops local_ci) + #2285 (project-trust
  plan) — this arc touches superpowers src/tests + .planning only.

## Decisions

- D1 condition: env-derived exclusion tokens only (post-`!` reset),
  intersected with actual skill dir names — the line NEVER fires for
  default-only exclusions (nothing newly unreadable) and never names
  phantoms.
- D2 name them: the F2 line already names brainstorming; an unnamed
  prohibition contradicts a named instruction. Withholding prevents
  nothing (the model does targeted recon on names it already knows).
- D3 wording (≤~220 chars), inserted immediately AFTER the F2 paragraph:
  "Excluded skills are UNREADABLE in this session: <names>. Do not read
  their SKILL.md, do not search for or construct paths to them, and do not
  act on any instruction above that names them — pick a non-excluded skill
  or proceed directly." Sentinel export: EXCLUDED_UNREADABLE_MARKER =
  "Excluded skills are UNREADABLE" (test + PB-09 bundle-grep target).
- D4 cache: compose at first build into the cached string (production env
  is process-stable; tests have _resetBootstrapCacheForTests; documented
  asymmetry).
- D5 POST detector: behavioral (forbid:brainstorming PASS) + PB-09
  byte-verify; pre-registered verdict tree: PASS iff forbid ok; RED-with-
  sentinel-shipped = genuine finding (no reroll/reword); ≤2 legs.

## Tickets

- [ ] t01 open effort (this commit)
- [ ] t02 bootstrap line + unit tests + gates (superpowers + wayfind guard)
- [x] t03 deploy + sentinel grep + paired C4 POST receipt (pre-registered
      verdict tree)
- [ ] t04 close-out: reviewer, PR chain (status flip in landing PR),
      learnings delta, successor

## Frontier

- t01/t02: the unit suite is the fastest falsifier; everything downstream
  composes from the line.

## Fog of war

- Whether naming + prohibition flips gemma — that IS the measurement;
  fallback is a recorded dated finding (no in-arc prompt-tuning).
- Conditional-line token cost (ratchet asserts the cap).
- `current` may move mid-arc (pin explicit dirs).

## Results (2026-09-15, evidence/c4/)

- **Deploy**: 0.10.4+ga244e3a（sibling 已把 s2-agent 版本推進到 0.10.4 —
  同一 g-sha 但 0.10.3+ga244e3a 目錄被我誤拼路徑，實際存在的是 0.10.4+）。
  Post-deploy E2E 全綠；sentinel byte-grep =1（PB-09）。
- **C4 POST: PASS** — `forbid:brainstorming` ok、pin:match ok。與 PRE
  (evidence/c4/pre.json — gemma 路徑猜測讀了被排除的 brainstorming) 構成
  完整配對：UNREADABLE 行翻轉了行為。
- 附註：驅動器的 scratch 副本已除役 — 本輪起一律使用 canonical 的
  wayfind/scripts/drive-case.ts（本輪發現 scratch 在多輪編輯後損壞）。

## Shipped-as (2026-09-15)

- PR <impl>: UNREADABLE bootstrap line + tests + paired C4 receipt.

## Results (2026-09-15 深夜, evidence/c4/)

- **Deploy**: 0.10.4+ga244e3a（post-deploy E2E 全綠；sentinel byte-grep =1）。
- **C4 POST (glm-5.3, 修正後)**: **PASS** — `forbid:brainstorming` ok、
  `pin:match` ok（glm-5.3 × 7 turns 全 non-error）、工作完成（scratch/hello.ts
  建立 + TDD 紅綠）。**UNREADABLE 行翻轉了行為**：被排除的 brainstorming
  未被讀，模型依 override 條款改讀 TDD。
- **過程教訓（reviewer round 1 + 執行插曲）**：
  - C4 POST 第一次是空跑（shell 沒 eval ZAI_API_KEY + LM Studio 伺服器被
    關）— liveness guard 正確判 INCONCLUSIVE 而非 PASS，審查要求的行為
    已編碼進驅動器。
  - 部署目錄是 0.10.4+（sibling 已 bump 版本）— 路徑拚錯 0.10.3+ 會 ENOENT。
  - 驅動器 scratch 副本已損壞除役 — 本輪起一律用 canonical
    wayfind/scripts/drive-case.ts。

## Shipped-as (2026-09-15)

- PR <impl>: UNREADABLE bootstrap line（條件式、env 衍生、D1 newly-
  unreadable 語義、D4 快取語義）+ description/detector 測試 + 配對 C4
  接收 + liveness guard。含 reviewer round 1 的 D1/driver 修正。
