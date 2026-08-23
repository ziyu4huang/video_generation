---
type: task
blocking: 1
---

## Question

Superpowers housekeeping: (a) `tests/helpers/mock-pi.ts` extracts `createMockPi` (was ×2 in bootstrap + skill-exclude tests); one dir-walker helper replaces `listSkillFiles`/`allSkillDirNames`; `skill-exclude.test.ts` imports real `DEFAULT_SKILL_EXCLUDE` instead of restating. (b) Doc truth pass: README peer 0.80.7 → 0.84.2, post-S1 skill counts, "byte-pinned with sanctioned local divergences — truth = UPSTREAM.ref + CONTEXT.md", delete stale dist/ build claims (`src/superpowers.ts:121` comment, src/index.ts header), package.json description count. Deploy-plumbing duplication: document-only per D3 ("deploy asset resolution" section in both CONTEXT.md files naming the 5 sites + the `#pi/ext-dir` contract).

## Resolution

Landed 2026-08-21 (phases S3+S5, branch feat/superpowers-s3-s5-dedupe-docs).

S3: new `tests/helpers/mock-pi.ts` (createMockPi, was ×2) + `tests/helpers/skill-dirs.ts` (one walker: `allSkillDirNames`/`listSkillDirs`, replacing three hand-rolled listings); `skill-exclude.test.ts` now imports the REAL `DEFAULT_SKILL_EXCLUDE` (re-export added to src/index.ts) instead of restating it.

S5: README truth (peer 0.84.2; 14 skills = 13 pinned ports + dispatch-recovery; merged-body pin reality with UPSTREAM.ref as truth; v-b-c deletion noted); package.json description enumeration fixed (v-b-c dropped, "verbatim" → "pin-guarded with sanctioned divergences"); stale `dist/`-build comments fixed in src/superpowers.ts + extensions/superpowers.ts.

D3 (document-only): "Deploy asset resolution" sections added to superpowers + wayfind CONTEXT.md naming the 5 duplication sites and the consolidation candidate.

Gates: superpowers 139/0 + typecheck; adr-citation + skill-reference 22/0.

closed: (landed)
