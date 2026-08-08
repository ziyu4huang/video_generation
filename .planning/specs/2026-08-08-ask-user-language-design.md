# ask-user TUI language hardening — Design Spec

> **Date:** 2026-08-08
> **Status:** design → pending implementation

## Goal
Add an `askUserLanguage` setting that STRICTLY fixes the `ask_user_question` TUI language — both the model-authored CONTENT (question, header, option labels, descriptions, previews) AND the TUI CHROME (footer hints, Submit/Cancel, "Type something.", "Next") — INDEPENDENT of `responseLanguage` and OVERRIDING it for `ask_user_question` only. When `askUserLanguage` is unset: content falls back to `responseLanguage` steering; chrome falls back to English (status quo).

## Background
The whole language mechanism is in-repo (editable, NOT the immutable upstream npm package): the `force-response-language` patch (`bun-apps/pi-agent/src/patches/force-response-language.ts`) injects a per-turn `<response_language>` block; the `/response-language` command lives in `bun-apps/pi-agent-ext-core-task/src/response-language/`; the ask-user TUI lives in `bun-apps/pi-agent-ext-core-task/src/ask-user/`. The TUI's `state/i18n-bridge.ts` is currently stripped to identity; chrome is hardcoded English; content language is steered only indirectly by the response-language block.

## Design

### 1. Setting
New top-level key `askUserLanguage` (BCP-47 tag, e.g. `zh-TW`) in `~/.pi/agent/settings.json`. Independent of `responseLanguage`. Read by raw file IO (same as responseLanguage — NOT a typed upstream Settings field).

### 2. Content hardening — prompt injection
Extend `force-response-language.ts`. Rationale: a second prototype wrap is blocked by the existing WeakSet + WRAP_TAG guard (`wrapInstallAgentNextTurnRefresh` is idempotent per-prototype), so BOTH language blocks must ride the SINGLE existing wrap. Add:
- `mapAskUserLanguageTag(tag)` + `resolveAskUserForcedBlock(settings)` — pure, share `LANGUAGE_LABELS`.
- A second env gate `BUN_PI_FORCE_ASK_USER_LANGUAGE` (default on), read via `envFlag` inside the block resolver.
- `currentForcedBlock()` returns the COMBINED block: response block + (ask-user block when `askUserLanguage` set AND its gate on), joined so the ask-user block appears with explicit "overrides response_language for ask_user_question content" wording. No-op when `askUserLanguage` unset.

Block text (when set):
```
<ask_user_language priority="forced" overrides="response_language">
For ALL content you author via the ask_user_question tool — question text, headers, option labels, option descriptions, and previews — you MUST use <label>. This OVERRIDES response_language for ask_user_question content ONLY. Conversation replies still follow response_language.
</ask_user_language>
```
Decision: extend the existing patch (not a sibling) due to the single-wrap constraint + shared LANGUAGE_LABELS. Patch name kept `force-response-language` to avoid rename churn (comment notes it now handles both; optional future rename to `force-language`).

### 3. Command — `/ask-user-language`
Mirror `/response-language`:
- Generalize `response-language/settings.ts`: add `getLanguageKey(settings, key)` / `withLanguageKey(settings, key, tag)` / `writeLanguageKey(key, tag)` (leave existing response fns intact or refactor to delegate).
- Reuse `command.ts`'s pure `parseLanguageArg` / `decideCommand` / `isValidTag` verbatim (they are key-agnostic).
- New registrar `ask-user-language.ts` → registers `/ask-user-language`; wire in `extensions/core-task.ts` beside `registerResponseLanguage`.

### 4. Chrome localization — i18n revival (Design A: read-settings-at-render)
- Revive `state/i18n-bridge.ts`: replace identity `t` with a real lookup that reads `askUserLanguage` from `~/.pi/agent/settings.json` (via the same-package `readSettingsFile()` from `response-language/settings.ts`), selects a dictionary, caches per-process. Add `__setLocaleForTest(locale)` seam (mirrors `ask-user/config.ts`) for deterministic tests.
- Convert inline chrome literals to `t()`:
  - `view/components/multi-select-view.ts` — `nextLabel` default ("Next") + the inline "Type something." in `renderOther()` → `displayLabel()`/`t()`.
  - `view/components/submit-picker.ts` — `["Submit","Cancel"]` → `t()`.
  - `view/.../dialog-builder.ts` — `HINT_PART_*` + `REVIEW_HEADING` / `READY_PROMPT` / `INCOMPLETE_WARNING_PREFIX` → resolve via `t()` (keep consts as English fallback).
- New `state/i18n-dictionaries.ts`: `zh-TW` (full) + `en` (identity) now; structured for easy addition. Unknown/unset tag → English fallback.
- KEEP `ROW_INTENT_META.label` and `RESERVED_LABEL_SET` / `RESERVED_LABELS` ENGLISH (identity-fallback + authoring contract; `row-intent.test.ts` pins them). Localize ONLY at render via `displayLabel()` / `t()`.

## Override semantics
- `askUserLanguage` SET → ask_user_question content (model) + chrome (TUI) use it, regardless of `responseLanguage`. Conversation replies still follow `responseLanguage`.
- `askUserLanguage` UNSET → content falls back to `responseLanguage` steering; chrome falls back to English.

## File inventory
- `bun-apps/pi-agent/src/patches/force-response-language.ts` — extend (ask-user block + combined resolution + env gate)
- `bun-apps/pi-agent/src/patches/force-response-language.test.ts` — add ask-user block tests
- `bun-apps/pi-agent-ext-core-task/src/response-language/settings.ts` — add generic language-key fns
- `bun-apps/pi-agent-ext-core-task/src/response-language/settings.test.ts` — add generic fn tests
- `bun-apps/pi-agent-ext-core-task/src/ask-user/ask-user-language.ts` — NEW registrar
- `bun-apps/pi-agent-ext-core-task/extensions/core-task.ts` — register /ask-user-language
- `bun-apps/pi-agent-ext-core-task/src/ask-user/state/i18n-bridge.ts` — revive (real t + locale + test seam)
- `bun-apps/pi-agent-ext-core-task/src/ask-user/state/i18n-dictionaries.ts` — NEW (zh-TW + en)
- `bun-apps/pi-agent-ext-core-task/src/ask-user/view/components/multi-select-view.ts` — literal → t()
- `bun-apps/pi-agent-ext-core-task/src/ask-user/view/components/submit-picker.ts` — literal → t()
- `bun-apps/pi-agent-ext-core-task/src/ask-user/view/<dialog-builder path>` — hint consts → t()
- tests: i18n-bridge tests; render-regression tests updated via `__setLocaleForTest("en")`; /ask-user-language entry smoke test

## Test plan (TDD, mirror existing bun:test patterns)
- Pure: `mapAskUserLanguageTag`, `resolveAskUserForcedBlock`, combined-block ordering, `getLanguageKey`/`withLanguageKey`, dictionary selection + fallback.
- i18n-bridge: `__setLocaleForTest` seam; `t()` localized for zh-TW; unknown key → fallback; unset/`en` → English identity.
- Render: existing render-regression tests inject `__setLocaleForTest("en")` (assertions unchanged); NEW test asserts zh-TW chrome.
- Command: `/ask-user-language` entry smoke test (mirror `entry.test.ts`).

## Success criteria
- Setting `askUserLanguage: "zh-TW"` makes the next ask_user_question render fully in zh-TW (content + chrome), even if `responseLanguage` is `en`; conversation still replies in `responseLanguage`.
- Unsetting `askUserLanguage` restores today's behavior.
- `/ask-user-language [tag]` flips it live (next render), mirroring `/response-language`.
- `bun test` green in both `pi-agent` and `pi-agent-ext-core-task`.
