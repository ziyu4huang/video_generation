# Phase 1 Recon: `bun-apps/pi-agent-ext-archify` test failure

Date: 2026-08-16. HEAD: detached @ origin/main. Status: recon complete except final cross-check of e2e.test.ts fixture usage.

## FAILURES (verbatim, `bun test`, package root)

```
71 pass / 21 skip / 1 fail — Ran 93 tests across 19 files. [5.42s]
```

Single failing test (isolated run `bun test __tests__/vendored-bin-recovery.test.ts` → `3 pass / 1 fail`):

```
(fail) vendored archify bin — recovered subcommands > examples re-renders every bundled example IR to HTML [132.65ms]
```

Assertion block:

```
36 |     const examplesDir = join(PKG_ROOT, "vendored/examples");
37 |     const before = readdirSync(examplesDir).filter((f) => f.endsWith(".html"));
38 |     const r = run(["examples"]);
39 |     expect(r.status).toBe(0);                    // PASSES — exit 0
40 |     const after = readdirSync(examplesDir).filter((f) => f.endsWith(".html"));
41 |     expect(after.length - before.length).toBeGreaterThanOrEqual(5);
error: expect(received).toBeGreaterThanOrEqual(expected)
Expected: >= 5
Received: 0
    at vendored-bin-recovery.test.ts:41:42
```

Typecheck passes (per task brief); only `bun test` fails.

## LAST CHANGE

```
0416190e feat(webui): view notifications ... (#1476)      → archify: README.md only (+2)
7e43478a docs(archify): add webui architecture diagram (#1466) → lib/ir/*.json + *.html only (new files)
```

No commit touched the test, `commandExamples`, or `vendored/scripts/render-examples.mjs`. **Correlation: NONE.** The failure is stateful/environmental, not commit-introduced.

## EVIDENCE

1. Test `__tests__/vendored-bin-recovery.test.ts:34-45` — counts `.html` files in `vendored/examples/` before vs after running `archify examples`, expects ≥5 NEW files, then deletes the new ones (`rmSync ... force`) so the vendored tree stays clean. Comment in file: "compare before/after and clean up so the test leaves no generated artifacts".

2. `vendored/examples/` currently contains 5 HTML files (dataflow-product-analytics.html, lifecycle-agent-run.html, sequence-cache-miss-request.html, web-app-rendered.html, workflow-agent-tool-call-rendered.html), mtime Aug 16 08:33 — exactly when this recon's test runs executed. JSON IRs all date Jul 25.

3. `.gitignore` (package): line 3 `/vendored/examples/*.html` with comment "`archify examples` regenerates these rendered HTMLs beside the source IRs." → git tracks 0 HTMLs there (verified `git ls-files | grep -c html` = 0) and `git status --porcelain` shows clean.

4. `vendored/bin/archify.mjs:1006-1007`:
   ```js
   function commandExamples() {
     const result = runNode([path.join(skillRoot, 'scripts/render-examples.mjs')], { cwd: skillRoot });
   ```
   `vendored/scripts/render-examples.mjs` renders exactly the 5 TARGETS via `execFileSync` to `outputRoot = examples` (argv[2] default). Renderers OVERWRITE existing files (execFileSync with explicit output path). **`archify examples` exits 0 regardless.**

5. Mechanism of failure: the 5 HTMLs already exist on disk (from a previous `archify examples` run — likely some earlier test/dev session left them; they're gitignored so invisible to git and to repo-state checks). On re-run, renderers overwrite in place → `after.length - before.length === 0` → assertion fails with Received: 0. The test's cleanup loop only removes files NOT in `before`, so pre-existing leftovers persist forever and wedge the test.

6. Only the 4 vendored-bin-recovery tests + e2e/real-result tests reference `vendored/examples`; e2e/real-result are the 21 skipped (env-gated) tests — they did not create the leftovers. `bun run deck` (deck.test.ts) reads JSON only.

## HYPOTHESES (UNCONFIRMED — no fix design yet)

**H1 (STRONG): Pre-existing gitignored `*.html` leftovers in `vendored/examples/` cause a false-new-file-count of 0.** A prior invocation of `archify examples` (dev workflow documented in `.gitignore` comment) left the 5 rendered HTMLs on disk; the test's before/after diff counts 0 new files while the command actually succeeded (exit 0). Supporting: evidence 2/3/5 — `r.status === 0` passes, 5 HTMLs present with older-than-test-run semantics, overwrite-in-place render path. The recon test runs themselves refresh mtimes (Aug 16 08:33), which masks the original creation time, but presence of 5 files before this session started is inferred from `before.length` ≥ 5 (Received: 0 requires after=before).

**H2 (WEAK): `render-examples.mjs` changed to overwrite instead of producing distinct output names.** No commit touches it (evidence in LAST CHANGE); its current TARGETS map 1:1 to the 5 found files with identical names. Nothing suggests recent change. Rank below H1.

**H3 (WEAK): Some concurrent process writes the HTMLs before `before` snapshot.** Test process is synchronous spawnSync; no parallel writer observed. No supporting evidence.

**Conclusion so far:** H1 — stale, gitignored, self-regenerating artifacts (test cleans only *new* files; leftovers are immortal) make an idempotent-renderer command look like a no-op. Root-cause fix direction (NOT designed here, per Phase 1): clean pre-existing HTMLs before measuring, or count regenerated (mtime-changed) files instead of new ones.

## Unfinished (for Phase 2 if needed)
- Was mid-way checking `e2e.test.ts:52` / `real-result.test.ts:12` fixture usage of VENDORED_EXAMPLES (both are in the 21 skipped env-gated tests; low relevance).
- Confirm nothing else in repo invokes `archify examples` outside tests (grep of skills/scripts found no caller; only test file + receipts doc mention it).
