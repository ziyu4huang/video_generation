---
name: research
description: Use when you want a question investigated against high-trust primary sources and the findings captured as a Markdown file — delegate the reading legwork to a background subagent so you keep working while it reads.
---

# Research

Investigate a question against **primary sources** and capture the findings as a Markdown file in the repo, so a future agent (or you, next session) can trust it without re-doing the reading.

## Do it in a background subagent

Dispatch a **background subagent** (the `subagents`/`subagent` dispatch — see the `subagent-dispatch-discipline` skill for how to scope it tightly) to do the research, so you keep working while it reads. Give it the question, the output path, and the citation rule below; it reports back when the file is written.

Its job:

1. **Investigate the question against primary sources** — official docs, source code, specs, first-party APIs, the code under your feet — not a secondary write-up of them. Follow every claim back to the source that owns it. A blog paraphrasing the docs is a lead, not a citation; the docs are the citation.
2. **Write the findings to a single Markdown file, citing each claim's source** — a link, a file:line, a commit, an API response. An uncited claim is a hunch; either find its source or mark it explicitly as the agent's inference.
3. **Save it where the repo already keeps such notes**; match the existing convention. If there is none, put it somewhere sensible under `.planning/<effort>/` (a `findings.md`, or a `research/` note next to the decision it informs) and say where, so the next reader can find it.

## What this is not

- Not a search-and-summarize of whatever ranks first — primary sources only, and the gaps where no primary source exists are themselves a finding worth recording.
- Not a substitute for grilling a decision — research gathers *facts*; if the question is a *decision*, take what it found into `grill-me-with-docs` and resolve it there.
