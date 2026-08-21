---
type: task
blocking: 1
---

## Question

Superpowers housekeeping: (a) `tests/helpers/mock-pi.ts` extracts `createMockPi` (was ×2 in bootstrap + skill-exclude tests); one dir-walker helper replaces `listSkillFiles`/`allSkillDirNames`; `skill-exclude.test.ts` imports real `DEFAULT_SKILL_EXCLUDE` instead of restating. (b) Doc truth pass: README peer 0.80.7 → 0.84.2, post-S1 skill counts, "byte-pinned with sanctioned local divergences — truth = UPSTREAM.ref + CONTEXT.md", delete stale dist/ build claims (`src/superpowers.ts:121` comment, src/index.ts header), package.json description count. Deploy-plumbing duplication: document-only per D3 ("deploy asset resolution" section in both CONTEXT.md files naming the 5 sites + the `#pi/ext-dir` contract).
