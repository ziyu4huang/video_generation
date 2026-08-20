---
name: research-pi-packages
description: Research Pi.dev / Pi Coding Agent ecosystem packages and write structured summaries to weekly-news/. Use when asked to explore, summarize, or track Pi extension ecosystem developments, new packages, or package comparisons.
---

# Research Pi Packages

## When to Use
Research the Pi Coding Agent ecosystem: single-package deep dives, multi-package
trend overviews, or feature comparisons. Output → `weekly-news/pi-packages-<saturday>.md`.

## Procedure
1. Clarify the goal: single package | multi-package trend | feature comparison.
2. Single package: `web_search` / `fetch_content` from `pi.dev/packages/{name}`
   and npm, then read the GitHub README.md, package.json, src/index.ts.
3. Multi-package trend: `web_search` (use the `queries` array with 2-4 varied
   angles) for recent popular / newly-released packages on pi.dev/packages.
4. For each package record: positioning & philosophy, install + dependencies,
   tools/commands/slash-commands, architecture & Pi-SDK integration, comparison
   with similar packages, benchmark data or use cases (if any).
5. Write to `weekly-news/pi-packages-<YYYY>-<MM>-<DD>.md` where `<DD>` is that
   week's **Saturday** (Saturday-anchored filename).
6. Frontmatter `created` = the actual run date (NOT the filename date).
7. 繁體中文 body, technical terms in English; use tables, lists, code blocks.

## Pitfalls
- pi.dev/package pages are often thin — cross-check GitHub, npm, source code.
- `fetch_content` auto-clones large repos but truncates; use `read` + offset/limit
  for core files.
- Mark archived/deprecated packages explicitly (e.g. pi-task-tree is archived).
- **Filename date vs created date**: filename = Saturday of the coverage week;
  created = when the file was actually written. Don't fake `created` to match.
- Before overwriting an existing same-Saturday file, read it and append/update.

## Verification
1. `weekly-news/pi-packages-*.md` exists with valid frontmatter
   (created, tags incl. `domain/pi` + `source/pi-dev`, source, type).
2. Single-package study ≥3KB; multi-package overview ≥5KB.
3. Structure complete: intro, feature analysis, architecture, comparison, refs.
4. Links (pi.dev, GitHub, npm) all valid.
5. Comparisons include a comparison table.
