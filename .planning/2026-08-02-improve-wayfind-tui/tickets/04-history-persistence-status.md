## Question

Does pi persist input history across sessions, and does claude-code?

- **pi:** confirmed **NO** on-disk persistence — history is the in-memory `Editor.history` array (`pi-tui/dist/components/editor.js`), `unshift` on submit, lost when the process exits. No history-file I/O exists anywhere in `pi-coding-agent/dist`.
- **claude-code:** determine whether prompts persist across sessions, and if so where/how (file path, format, cap, scrubbing). This gives the persistence-policy decision a concrete target to match or diverge from.

type: research
blocked by: _(none)_

## Resolution

**claude-code persists; pi does not.** claude-code saves input history locally under `~/.claude/`, scoped **per working directory by default** (`commandHistoryScope` in `~/.claude/settings.json` ∈ `session` | `directory`(default) | `global`). Multiple CLIs in the same dir share history live. Sessions/transcripts are JSONL per project path; `claude project purge` wipes it.

pi: in-memory `Editor.history` only, lost on exit (confirmed: no history-file I/O in `pi-coding-agent/dist`).

So persistence **is** a real gap. Concrete target for [05](05-history-persistence-policy.md): match claude-code's **directory-scoped** model (per-cwd `history.jsonl` under the agent dir), with a cap + dedup, optional scope config.

Sources: code.claude.com/docs/en/sessions, /cli-reference; github issues 41263, 20064.

closed: 2026-08-02
