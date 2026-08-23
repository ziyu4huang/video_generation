# 04 — Tools, CLI twin, skill, docs, tests for v2

**Status: closed (2026-08-23)**

## Task

Wire the v2 pipeline into the agent tool + CLI, ship the agent-facing skill,
refresh the docs, and right-size the test suite for the new pipeline.

## Work done

- `extensions/file2md.ts` — param swap: `mode` (auto|text|ocr|vlm), `note`,
  `scale`; `extract`/`dpi`/`mode-as-note` removed; `runFile2mdPipeline` called;
  gate family, knowledge emission, `vision_ask` untouched.
- `s2-agent/src/cli/commands/file2md.ts` — `runFile2mdPipeline`, flags
  `--extract` (auto|text|ocr|vlm), `--note`, `--lang`, `--scale`; docs updated.
  `args.ts` (scale float 0.1–16, note/lang fields) + `flag-spec.ts` (ValueField
  entries; `--mode` remains the CLI output mode).
- `skills/file2md/SKILL.md` — markdown-converter-style contract: formats,
  modes, caps, truth rules, completion checklist (frontmatter = name +
  description only).
- Docs: README v2, PRD v2, CONTEXT.md glossary v2, `docs/architecture.md` v2
  chain + existing `vision_ask` trace kept, `docs/adr/0001-vendored-bun-only-stack.md`.
- Tests: new `__tests__/{sniff,raster,ocr,convert,pipeline-v2}.test.ts` +
  `helpers/docs.ts` (in-process fixtures via pdf-lib/exceljs/our PNG encoder);
  8 stale v1 test files deleted; `--isolate` retained; e2e arg-validation
  switched to `--scale`; run-test comment un-pinned.
- `scripts/build-bundle.ts` — self-verify param list updated; thin bundle
  builds, factory test green (4.5MB WARN — expected dep growth).

## Gate

file2md `check/typecheck/test`; s2-agent typecheck + cli-argv + e2e; devops
deploy-report; smoke (text pdf / scanned pdf OCR / xlsx) via the CLI command
path — outputs verified by content, not just exit code.
