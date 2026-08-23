---
ticket: 01-ask-user-cc-parity
effort: cc-parity-task-ext
type: task
status: open
created: 2026-08-23
last: 2026-08-23
---
# 01 — ask_user_question CC parity (schema + description + TUI)

> Spec §4.1, decisions D1/D2.

## Goal

A model that has learned Claude Code's AskUserQuestion produces CC-equivalent calls
against `ask_user_question` and gets CC-equivalent answers back.

## What to build

1. `tool/types.ts`: `MAX_HEADER_LENGTH` 16→12 (CC wording); label hard-limit removal
   (keep a guardrail only if wrap-regression tests demand one — decide in-ticket);
   delete `recommended` field; add `preview_on_multiselect` validation error;
   preview/multiSelect/question descriptions rewritten to CC phrasing.
2. `ask-user-question.ts`: tool description restructured to CC's (when-to-use list,
   usage notes, recommended = "(Recommended)" suffix + first position, preview
   paragraph, plan-mode paragraph referencing `src/plan/`); `DEFAULT_PROMPT_SNIPPET`
   and `DEFAULT_PROMPT_GUIDELINES` aligned.
3. TUI: ⭐ keyed off suffix detection, suffix stripped from display; audit
   `view/components/preview/` against CC's monospace-markdown side-by-side box and
   align where already close.
4. Migrate tests that author `recommended: true` / 16-char headers; keep
   `recommended-marker.test.ts` semantics via the suffix form.

## Acceptance

- Schema rejects: header >12 chars; `preview` on a multiSelect question; duplicate /
  reserved labels (unchanged).
- No schema field named `recommended` remains; grep clean.
- Tool description contains CC's four usage-note rules and the plan-mode paragraph.
- All ask-user tests green in the suffix form.

## Gate

`( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test )`
