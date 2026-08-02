## Question

Given [04](04-history-persistence-status.md) — claude-code persists input history **per working directory** by default (configurable scope). Should pi match that, and how exactly?

**Recommendation: yes — add directory-scoped persistence.**
- **Where:** per-cwd `history.jsonl` under the pi agent dir (mirror claude-code's per-project layout).
- **Cap + dedup:** keep pi's cap (100) + skip-dup-of-most-recent.
- **Scope knob:** optional `historyScope` setting (`cwd` | `session` | `global`), default `cwd` — or ship cwd-only now and defer the knob.
- **Scrubbing:** exclude `!` bash lines / scrub secrets? (decide per privacy appetite.)

Or reject (privacy / per-project isolation) and record why.

type: grilling
claimed: wayfind-session (2026-08-02)
blocked by: 04

## Resolution

**Yes — add cwd-scoped input-history persistence (MVP).** Decided:

- **Scope:** per-cwd `history.jsonl` under the pi agent dir (mirrors claude-code's directory default). No config knob in the MVP — deferred (see below).
- **Capture:** listen on the `input` event (`InputEvent.text`, `source`); persist interactive prompts only. **Exclude `!` bash lines** (they route through the separate `user_bash` event and can leak secrets). Keep `/` slash commands.
- **Restore:** via the repo's monkey-patch flow (`bun-apps/pi-agent/src/patches/`) — patch the editor / interactive-mode to feed the persisted entries into the editor's `addToHistory` on `session_start`. No upstream PR needed (`addToHistory` exists on the compiled `Editor`; the patch surfaces/invokes it). Confirmed feasible: capture is extension-clean, restore is one patch in the established pattern.
- **Cap + dedup:** inherit pi's existing in-memory policy — cap 100, skip-dup-of-most-recent.
- **Scrubbing:** exclude `!` bash only. No secret-pattern scrubbing in the MVP (rely on per-cwd locality + local file); revisit if it bites.

**Deferred (not in MVP):** a `historyScope` setting (`cwd` | `session` | `global`) — claude-code's configurability. Ship cwd-only first; add the knob only if wanted.

**Implementation = handoff.** The decision is fully specified; building it (the patch + a small persistence module + tests) is a `writing-plans` task, not a map decision. Past the map's edge.

closed: 2026-08-02
