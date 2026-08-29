# 02 — pi- residue rename

blocking: none

## What

Rename skill `pi-memory-bulk-dedup` → `memory-bulk-dedup`; fix
`grill-memory` description ("pi memory" → s2-agent wording). Adjudicate
`research-pi-packages` (its "pi" may correctly name the upstream Pi.dev
ecosystem — keep unless it reads as residue).

## Verdicts (2026-08-29)

- **`pi-memory-bulk-dedup` → `memory-bulk-dedup` — RENAMED.** Dir + SKILL.md
  `name:` + description ("pi memory target" → "hermes-memory target") +
  DEDUP path in the procedure + `dedup.ts` header/HELP comments +
  `tests/dedup-parity.test.ts` (path + HELP golden — one deliberate
  post-capture divergence, noted in the test's provenance comment) +
  `src/store/skill-utils.test.ts` (path + expected name + version 3→4,
  updated 2026-08-29). Path literals that are FACTUAL stay: env
  `PI_CODING_AGENT_DIR`, dir `~/.pi/agent`, store dir `pi-hermes-memory/`
  (unchanged by design per the s2-agent rename ADR). 9 reference sites, all
  inside hermes-memory; vault kcard notes referencing the old name are
  cross-repo historical records (vault-side PR SOP), untouched.
- **`grill-memory` — NO-OP.** The map's claim is STALE: the SKILL.md
  contains zero "pi" strings (verified `grep -rn "pi"
  skills/grill-memory/SKILL.md` → no hits). Nothing to fix.
- **`research-pi-packages` — KEEP (D4).** Its "pi" names the UPSTREAM
  Pi.dev / Pi Coding Agent ecosystem the skill researches (`pi.dev/packages`,
  npm cross-checks) — semantically correct, not rename residue. Renaming
  would obscure the target ecosystem.

## Done when

- [x] Renames applied (skill dirs + registrations + manifest regen)
- [x] research-pi-packages verdict recorded (keep or rename + why)
- [x] All reference sites updated (grep clean for old names)
- [x] Package gates green (hermes-memory `bun run test`: 1559 pass / 0 fail,
  incl. the parity golden re-pinned to the renamed HELP)
