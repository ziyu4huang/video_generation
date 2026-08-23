---
type: task
blocking: 01, 02
status: open
---

# 03 — E2E suite hardening + docs + CLI surface

## Question
Is the smart ladder covered end-to-end across every branch — including resume/`--pages`
interaction — and documented for the next session that converts a figure-bearing spec?

## What to build
The smart-mode E2E suite reaches full branch coverage: ladder-order assertions, both figure
paths (text-caption and scan-OCR-band), the no-VLM degrade, the vision-guard degrade, plus the
resume interaction (a manifest already carrying `figure` records must not redo enhancement for
done pages) and `--pages` filtering over figure pages. The SKILL.md gains a smart-mode section
(mode table row, ladder description, thresholds, degrade semantics, the caption-only figure
page rule now pointing at smart as the automated path). The architecture doc records the
ladder. The CLI help text (modes list + example) and the extension tool's mode parameter carry
`smart`. The package `CONTEXT.md` glossary gains the new terms (smart mode, figure page,
enhance ladder) per the domain-modeling rule.

## Acceptance
- [ ] Smart-mode E2E suite covers every ladder branch including resume-no-redo and `--pages`
      interaction (call-counter + manifest assertions)
- [ ] SKILL.md documents the smart ladder: mode table, thresholds as constants, degrade
      notice wording, figure-page rule pointing at smart
- [ ] CLI help shows `auto|text|ocr|vlm|smart` and a `--extract smart` example
- [ ] `CONTEXT.md` gains `smart mode`, `figure page`, `enhance ladder` terms with `_Avoid_:`
      lines
- [ ] Package canonical `bun run test` green (203 + new tests), typecheck + check clean
