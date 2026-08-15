> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
---
effort: 2026-08-11-extensions-browser-distinguish-skill-commands
created: 2026-08-11
last: 2026-08-11
status: active
---

# Wayfinder map: 2026-08-11-extensions-browser-distinguish-skill-commands

## Destination

Make the `/extensions` browser distinguish real registered commands from pi's auto-generated `skill:<name>` wrappers, so skill-only extensions like superpowers don't appear to duplicate skills as commands.

## Notes

**Domain:** the `/extensions` slash command in `bun-apps/pi-agent-ext-power-tool/src/extensions-command.ts` (landed in PR #1222). Its summary line is `N tool · N cmd · N skill` per extension, with a detail drill-in listing tools / commands / skills by name.

**Mechanism (why skill-only extensions look duplicated — NOT a bug):**

- pi exposes **two** overlapping APIs. `pi.getCommands()` returns `[...extensionCommands, ...templates, ...skills.map(s => ({name: \`skill:${s.name}\`, source: "skill", ...}))]` — i.e. pi **auto-wraps every skill as a `skill:<name>` slash command**. Separately, pi lists each skill in the system prompt.
- The `/extensions` browser sources the **commands** column from `pi.getCommands()` and the **skills** column from `ctx.getSystemPromptOptions().skills`. **Both derive from the same `getSkills()` array**, so for a skill-only extension they overlap 1:1.
- `pi-agent-ext-superpowers` registers **zero** commands itself. Its 13 entries under "commands" are entirely the auto-generated `skill:<name>` wrappers; its 13 entries under "skills" are the same 13 skills. The browser faithfully renders two distinct pi APIs that happen to coincide for skill-only extensions — which reads to a user as "superpowers registers 13 duplicate commands".

**Standing preferences:** reply zh-TW, artifacts English; planning-only (this effort), no code landed yet.

## Decisions so far

- [01 · Distinguish skill commands from skills](tickets/01-distinguish-skill-commands-from-skills.md) — open. The duplication is pi's intentional dual exposure, not a registration bug. Recommended fix: in `groupByExtension` / `renderSummary`, detect commands with `source === "skill"` and fold them into the skills count rather than double-counting, so superpowers reads `0 cmd (+13 /skill:) · 13 skill`. Requires the browser's `Sourced` type to carry the `source` field pi already sets.

## Not yet specified

- Exact summary-line wording once fix (2) is chosen (e.g. whether to show `(+13 /skill:)` inline, a footnote, or a dedicated sub-count). Decided at implementation time.
- Whether the detail view (`renderDetail`) should also visually separate `skill:` entries, or only the summary line. Ticket 01 lists this as an option, not yet decided.

## Out of scope

- **Any pi-core change** to how `getCommands()` wraps skills or how `getSystemPromptOptions().skills` is populated. This is a **browser-side clarification only** — the `/extensions` command should *render* the distinction accurately, not change pi's dual-exposure design (which is intentional and consumed elsewhere).
- Removing the `skill:<name>` slash commands themselves — they are a real pi feature users invoke as `/skill:<name>`.
- Generalizing to non-skill-only extensions (those that register real commands AND skills) — the fix is correct for them too as a by-product, but this effort is scoped to the misleading-symmetry case.

## Cross-effort links

- **Builds on:** [2026-08-02-improve-extension-co-operation-less-hard-couplin](../2026-08-02-improve-extension-co-operation-less-hard-couplin/map.md) — established that extension packages cooperate via pi's runtime discovery surface (`getAllTools`, `getCommands`, `getSystemPromptOptions`), which is exactly what the `/extensions` browser renders per-extension.
