---
type: task
status: open
---

# Distinguish skill commands from skills in the /extensions browser

## Question

In the `/extensions` browser (`bun-apps/pi-agent-ext-power-tool/src/extensions-command.ts`, PR #1222), every loaded skill appears **TWICE** for skill-only extensions like `pi-agent-ext-superpowers`:

- once as `skill:<name>` under **commands**, and
- once as `<name>` under **skills**.

Concretely, superpowers shows **13 cmd · 13 skill** in `renderSummary`, and its `renderDetail` lists 13 `skill:…` entries in the commands section plus the same 13 entries (sans `skill:` prefix) in the skills section.

**This is NOT a duplication bug — it is pi's intentional design:**

- pi exposes two overlapping APIs. `pi.getCommands()` is built as `[...extensionCommands, ...templates, ...skills.map(s => ({name: \`skill:${s.name}\`, source: "skill", ...}))]` — i.e. **pi auto-wraps every skill as a `skill:<name>` slash command** (with `source: "skill"`).
- Separately, pi lists each skill in the system prompt, surfaced to extensions via `ctx.getSystemPromptOptions().skills`.
- The `/extensions` browser sources its **commands** column from `pi.getCommands()` and its **skills** column from `ctx.getSystemPromptOptions().skills`. **Both columns derive from the same underlying `getSkills()` array.**
- `pi-agent-ext-superpowers` registers **zero** commands of its own. Its entire "commands" column is the auto-generated `skill:<name>` wrappers; its "skills" column is the same skills. The browser faithfully renders two distinct pi APIs that overlap 1:1 for skill-only extensions.

The UX harm: a user reading `13 cmd · 13 skill` for superpowers infers the extension registers 13 (duplicate) commands, when in fact it registers 0 — every "command" is pi wrapping a skill.

## What to build

Clarify the rendering so skill-only extensions don't look duplicated. Candidate fixes:

1. **Relabel + footnote (cheapest, non-behavioral).** Keep counting `skill:` entries as commands but relabel the commands section and add a footnote: *"Every skill is also invokable as `/skill:<name>`."* Minimal change; still shows a misleadingly high cmd count.

2. **Accurate accounting in `groupByExtension` / `renderSummary` (recommended).** Detect command entries whose `source === "skill"` (the field pi already sets when wrapping skills) and fold them into the skills count rather than double-counting. Superpowers would then read `0 cmd (+13 /skill:) · 13 skill` — accurate, non-duplicative, while still surfacing that those 13 skills are `/skill:`-invokable. Requires the browser's `Sourced` type (`extensions-command.ts`) to carry the `source` field pi already sets on the wrapped command, so the detection has data to key off.

3. **Mark `skill:` entries distinctly in `renderDetail`.** In the detail drill-in, render `skill:<name>` entries under a sub-label or with a `skill-wrapper` tag, rather than listing them as if they were real commands. Composable with (1) or (2).

**Recommendation: (2)** as the accurate-accounting fix — it directly removes the misleading double-count and exposes pi's real behavior (skills are invokable as `/skill:<name>`). It depends only on the browser's `Sourced` type carrying the `source` field pi already sets, so no pi-core change is needed. (3) is a natural follow-on for the detail view once (2) lands.

This is a **browser-side clarification**, not a pi-core change.
