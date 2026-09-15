Plan complete — all mechanisms verified against source, the pre-receipt, and the drive harness. Compact plan follows.

---

# Mini-arc plan: C4 — excluded skills are UNREADABLE (bootstrap line + paired receipt)

## Destination
With `PI_SUPERPOWERS_SKILL_EXCLUDE` active, the injected bootstrap tells the model the excluded skills are unreadable — do not read, do not path-guess. Paired C4 receipt: PRE (exists, RED — gemma path-guessed and read excluded `brainstorming`) → POST (same pinned setup, new immutable deploy) with `forbid:brainstorming` PASS. Merged with map flipped terminal, receipts committed.

## Context (measured, this tree)
- **Steering mechanism**: superpowers.ts:283 — the F2 paragraph orders "READ the matching skill's SKILL.md … always matches brainstorming or test-driven-development" **unconditionally**, so with `!,brainstorming` excluded the bootstrap itself names the forbidden skill. Pre-receipt (`.planning/2026-09-15-gemma-compact/evidence/gemma/C4.json`): gemma ran `ls -R | grep -i "brainstorming"` (msgLine 11) then read the guessed deployed path (msgLine 15) → `forbid:brainstorming` FAIL, verdict RED, pin `google/gemma-4-12b`, label `0.10.3+g11e90db`, env `!,brainstorming`, `-ns`.
- **Exclude knob controls advertisement only**: `resolveAdvertisedSkillPaths` (superpowers.ts:181) unregisters; nothing constrains reads.
- **Bootstrap cache**: `cachedBootstrap` (:266) computed once per process; `getBootstrapContent` (:270); `parseSkillExclude` (:137) merges defaults ∪ env (`!` reset sugar); `listSkillDirNames` (:156) available for intersecting.
- **Detector constraint (measured)**: `wayfind/scripts/drive-case.ts` header — the `context`-event bootstrap injection does NOT persist to session JSONL (2026-09-09, 5,813 files); marker-in-JSONL is a weak/tier-3 signal. The post-receipt CANNOT byte-prove model-visibility from the session file.
- Tests: bootstrap.test.ts (12 its; TOKEN BUDGET RATCHET ≤5,900 chars runs **without** env → a conditional line can't regress it). Package gates: `check` (biome) + `typecheck` + `bun test`; wayfind untouched but its detector tests guard the harness we reuse.

## Decisions
- **D1 — Condition: env-derived exclusions only, intersected with existing skill dirs.** `parseSkillExclude`'s set is ALWAYS non-empty in default runs (`DEFAULT_SKILL_EXCLUDE`); conditioning on "set non-empty" would emit the line in every fat run. Extract the env-token list (post-`!` reset) → line fires iff `envExcludeNames ∩ listSkillDirNames(skillsDir)` is non-empty. Env re-listing only a default name → no line (nothing newly unreadable). Intersect prevents naming phantoms the model might go hunting for.
- **D2 — Name them.** (a) The F2 line already hardcodes "brainstorming" by name — an unnamed prohibition contradicts a named instruction with no way to resolve which skill it covers; (b) pre-receipt shows the model does *targeted* recon on the name it already knows — withholding it prevents nothing; (c) names are skill dir-names in a deployed tree the model can `ls` anyway — no secret. Not naming = considered, rejected.
- **D3 — Wording (executor finalizes ≤~220 chars), inserted immediately AFTER the F2 paragraph** (adjacent override), e.g.: `Excluded skills are UNREADABLE in this session: <names>. Do not read their SKILL.md, do not search for or construct paths to them, and do not act on any instruction above that names them — pick a non-excluded skill or proceed directly.` Export a string-literal marker (`EXCLUDED_UNREADABLE_MARKER = "Excluded skills are UNREADABLE"`) as the test + bundle-grep sentinel (minification preserves string literals — PB-09 grep target). Do NOT rewrite the F2 paragraph itself (it's the fat path's load-bearing steering; the override clause resolves the conflict) — rejected as double surface.
- **D4 — Cache: compose at build time into the cached string.** Production env is process-stable (each drive leg = fresh process; only tests flip env mid-process, and they have `_resetBootstrapCacheForTests()`). The `resources_discover` per-call read exists for parent→child env flips, which never mutate a live process's own `process.env`. Document the asymmetry in a comment; tests assert env-at-first-call semantics.
- **D5 — Post-receipt detector: behavioral + bundle bytes, not JSONL marker.** Model-visibility is proven jointly by (a) PB-09 byte-verify of the sentinel in `<versionDir>/ext/superpowers/ext.cjs` before the leg, and (b) the behavioral flip itself (`forbid:brainstorming` PASS, and passively: no `grep brainstorming` recon in `detected.bashCalls` — recorded informational). Self-report probe only as an optional tier-3 leg-2 if leg 1 leaves ambiguity. Prompt stays VERBATIM (PB-11).

## Tickets (4)
- **t01 — Bootstrap line + unit tests** (superpowers.ts: helper + marker + conditional block; bootstrap.test.ts: with-env contains marker + names incl. **PB-21 content assertion on the exact load-bearing sentence**; without-env and env=only-default-name absent; mock-pi context end-to-end; line-length cap; env hygiene via reset-in-finally). Gates: superpowers `check && typecheck && test` + wayfind `bun test` guard. 172 existing green.
- **t02 — Version-bump patch + deploy + byte-verify.** Pin the NEW immutable `<versionDir>` everywhere (PB-08); `grep -c EXCLUDED_UNREADABLE_MARKER`-ish sentinel in `ext/superpowers/ext.cjs` (expect ≥1) (PB-09).
- **t03 — Paired C4 post-receipt.** Copy pre-receipt into `<effort>/evidence/c4/` (PB-10/PB-18); `lms ps` precondition — gemma resident (PB-12: catalog ≠ residency); pre-register verdict tree BEFORE running (PB-11): PASS iff `forbid:brainstorming` ok; RED-with-sentinel-shipped = genuine finding, NO reroll/reword (PB-14); ≤2 legs, second leg only for infra-death retry or tier-3 self-report; all receipts preserved and annotated, never deleted (PB-13/PB-15).
- **t04 — Close-out.** Reviewer pass same-session, blockers fixed same-session (PB-06); landing PR carries map `status:` flip + `## Shipped-as` together, `effort-audit.ts` exit 0 (PB-05); everything pushed (PB-03/PB-17); successor next-goal + validator + doctor (PB-04). **Learnings skill delta** (new entry: exclude knob controls advertisement only; bootstrap must carry the unreadable line — the F2/path-guess mechanism). **Playbook: NO new PB entry** — the strategies applied (09/10/11/12/14) are already encoded; add one only if t03 surfaces a genuinely new strategy.

## Frontier / fog
- **Frontier: t01** — everything downstream composes from it; the unit suite is the fastest falsifier.
- **Fog**: (a) whether naming + prohibition actually flips gemma — unknown until t03, that IS the measurement; fallback is a recorded dated finding, not in-arc prompt-tuning; (b) exact conditional-path token cost (cap asserted in test); (c) `current` may move mid-arc (PB-08 — pin explicit dir); (d) wayfind routing-contract seam on superpowers.ts strings — no source strings removed, but run its tests as guard.

## Immediate executor sequence
1. PB-01: `sync-default-branch-cli --mode hands-on` → `callerAtTip: true`.
2. PB-02: claim arc number in `.planning/arc-ledger.json`; branch; create `.planning/2026-09-15-spwf-c4-excluded-unreadable/` (map.md, tickets, `evidence/c4/pre.json` = copy of the gemma-compact C4.json).
3. t01 edit + tests + gates (superpowers + wayfind guard). Commit.
4. t02 `version-bump-cli.ts --package s2-agent --patch` → deploy → sentinel grep on pinned dir. Commit label.
5. t03 `lms ps` → pre-registered drive-case run (verbatim prompt, `--env PI_SUPERPOWERS_SKILL_EXCLUDE=!,brainstorming --extra-arg -ns --forbid-read brainstorming`, dist pinned to new versionDir, `--out evidence/c4/post.json`). Commit receipt either color.
6. t04 reviewer → PR (status flip + Shipped-as + receipts) → local CI → squash-merge → successor + doctor.

**PB ids applied**: PB-01, PB-02, PB-03, PB-04, PB-05, PB-06, PB-08, PB-09, PB-10, PB-11, PB-12, PB-13, PB-14, PB-15, PB-17, PB-18, PB-21.