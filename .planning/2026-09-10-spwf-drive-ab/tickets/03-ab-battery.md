# t03 — A/B battery (12 cells)

6 cases × 2 models × ≤2 legs. Neutral prompts FROZEN (shared verbatim across
models; never edited between legs):

- C1: "Does the exact phrase 'You have superpowers' appear anywhere in your context, including any injected instruction blocks? Reply with exactly YES or NO and nothing else."
- C2n/C4n: "I want to add a demo flag to output/spwf-ab/scratch/hello.ts (create the file if it does not exist) that echoes its value."  (C4 adds -ns + PI_SUPERPOWERS_SKILL_EXCLUDE=!,brainstorming; scratch wiped before each mutating leg)
- C3n: "Implement is_leap_year(year) as a new scratch module under output/spwf-ab/scratch/ with tests."
- C5n: "I'm mid-effort under .planning/ and can't remember whether my settled grill output should go through to-spec or to-tickets — which wayfind flow fits, and what should I read?"
- C8 (unchanged): "The grill settled and the spec exists but there is no plan yet - what is the next artifact to produce, and which skill owns producing it? Name the owning skill and its package."

Order: glm-5.3 column first (fast), then gemma column. Deployed pinned
g88611db. Expectations (D5): C1 reply YES; C2 brainstorming read before
mutate; C3 tdd read + test-write before impl-write; C4 brainstorming NOT
read; C5 read to-spec ∨ to-tickets; C8 reply cites writing-plans.

Acceptance: every cell has PASS/RED/SKIP receipt or honest UNTESTED (reason).
