---
type: task
blocking: []
status: closed
---

## Question
Malformed `blocked by:` / `blocking:` values (bracketed slugs like `[01]`, or missing `---` frontmatter delimiters) **silently parse-fail** — failure memory #471. The parser (`src/model.ts` ~`:177-181`) strips brackets but does not validate/reject bad input, so a misformatted ticket becomes an invisible no-op.

## What to build
- Harden `parseTicketFile` (`src/model.ts`): validate `blocking` entries are bare numbers; on malformed input emit a clear parse error/warning (not a silent skip). Keep accepting the documented good format (`01, 02`).
- Add tests: good format parses; bracketed-slug / non-numeric / malformed formats are detected and reported.

## Acceptance
- Malformed `blocking` is detected + surfaced (no silent no-op).
- Tests cover good + each bad format; `bun test` + `bun run typecheck` green in `pi-agent-ext-wayfind`.

## Resolution
Fixed in `1eb51c1c`: `parseTicketFile` now validates `blocking` entries are bare numbers and throws on non-numeric/bracketed-slug input (no silent skip); good format `01, 02` still accepted. Tests cover the good format and each malformed variant.
