# 02 — Lock the design: shape, force lever, prose back-compat

type: grilling
claimed: claude (chart-the-map session, 2026-08-01)
closed: 2026-08-01

## Question

Lock the three coupled design decisions that block the implementation. Each has
a recommended (⭐) answer; all three are presented together because they're
small and tightly interdependent.

### D1 — Setting shape & value format

What does the `~/.pi/agent/settings.json` entry look like?

- **⭐ `responseLanguage: "zh-TW"`** — a BCP-47 tag. pi maps the tag to a
  canonical, forceful instruction it owns ("Reply to the user in 繁體中文…").
  Machine-readable, validatable, consistent wording. (Scope is conversation
  language only; the artifacts-English half is deferred — see map Out of scope.)
- `responseLanguage: "<free-form instruction string>"` — the user owns the exact
  wording; max flexibility, but pi can't validate/standardize.
- Structured `{ conversation: "zh-TW", artifacts: "en" }` — encodes the full
  two-part policy explicitly. Most expressive, slightly heavier; pulls the
  deferred artifacts half back into scope.

### D2 — Force lever & "force" semantics

Which lever (from research ticket 01), and what does "force" mean?

- **⭐ `customPrompt` (`getSystemPrompt()`) injection — pure high-priority
  injection, no policing.** The block lands at the TOP of every session's system
  prompt, ahead of tools/context/role-labels. Matches "force inject to any
  session" literally; simplest robust guarantee.
- `appendSystemPromptOverride` — forced block in the append section (override
  hook designed for this). Sits after the base prompt.
- Injection **+ post-turn reply-language check** — a lightweight inspector that
  re-asserts the rule if a reply drifts. Strongest enforcement, but a bigger
  build and arguably beyond "inject".

### D3 — Backward-compat with the existing prose

Once the setting is load-bearing, what happens to the language sections in
`~/.pi/agent/AGENTS.md` ("Default conversation language") and `./CLAUDE.md`
("Conversation language: 繁體中文")?

- **⭐ Retire the prose; leave a one-line pointer** to `settings.json →
  responseLanguage`. Single source of truth; no drift between prose and setting.
- Keep the prose as human-readable doc, annotate that the setting is
  load-bearing. Doc-friendly but redundant.
- Leave both untouched (coexist). Simplest now, but the two will drift.

## Resolution

Grilled live (chart-the-map session, 2026-08-01). Decisions:

- **D1 — `responseLanguage: "zh-TW"`** (BCP-47 tag). pi maps the tag to a
  canonical, forceful instruction it owns. Conversation-language scope only;
  the artifacts-English half stays deferred.
- **D2 — `customPrompt` (`getSystemPrompt()`) top-of-prompt injection,
  PLUS a TUI slash command for dynamic, immediate control.** The forced block
  lands at the head of every session's system prompt (ahead of tools / context /
  role-labels). "Force" = guaranteed high-priority injection — **no** post-turn
  reply inspector (that option was not chosen). Additionally: a slash command
  (provisional name `/response-language [tag]`) that changes the language live —
  persists to `settings.json`, updates the in-memory value, and re-injects into
  the **current** session immediately (triggers a system-prompt rebuild so the
  next reply already uses the new language). No restart, no hand-editing.
- **D3 — retire the prose; leave a one-line pointer.** Remove the
  "Default conversation language" section from `~/.pi/agent/AGENTS.md` and the
  "Conversation language" line from `./CLAUDE.md`; replace each with a one-line
  pointer to `settings.json → responseLanguage` (and the `/response-language`
  command). Single source of truth.
