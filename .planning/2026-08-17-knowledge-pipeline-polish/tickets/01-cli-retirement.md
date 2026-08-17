## Question
L1: retire zk src/loop.ts (350) + src/merge.ts (337) with their CLI commands and tests?
type: task
blocked by: (none)
Detail per spec: loop = 1 CLI command + 1 test; merge = 3 CLI callsites retiring together. Remove modules, CLI wiring (pi-agent/src/cli), tests. Gates: zk typecheck + full suite green minus retired tests; nothing else imports them (census 02 verified).

## Resolution
Removed: zk src/loop.ts+merge.ts+2 tests; kcard-loop cmd+its unit test+e2e block; --merge-duplicates flag rows; merge stages in memory-to-vault/knowledge-pipeline; seam members mergeDuplicates+runConvergenceLoop (interface+zk impl+hermes mocks+assertions); comment banners rewritten; negative-guard in workflow test kept deliberately. Sweep grep 0 (only the workflow negative assertion remains).
