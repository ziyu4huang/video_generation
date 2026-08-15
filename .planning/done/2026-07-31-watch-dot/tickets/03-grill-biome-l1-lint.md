---
type: grilling
blocked by: [02]
status: closed
claimed: wayfind-session (2026-07-31)
resolved: 2026-07-31 (DO — biome as a CLI-lint lane in L1, severity by domain)
---

# 03 — Decide: add biome as an L1 TS/JS lint source

## Question

Decide `do / defer / skip` adding **biome** as an additional L1 lint source for
TS/JS, covering lint rules that `typescript-language-server` doesn't surface (unused
imports, style, suspicious patterns).

Facts: the repo **already uses biome** (e.g. `// biome-ignore lint/suspicious/...`
directives throughout `src/`), and the sibling effort's 02 research flagged L1 as
"only `typescript-language-server`, no eslint/biome." Biome has a `--stdio` LSP mode
and a CLI `lint`/`check` mode.

Mechanism fork (reuses whatever architecture 02 establishes):
- If 02 → **generalize** into a multi-provider L1 registry: biome plugs in as another
  provider (LSP `--stdio`).
- If 02 → **bolt-on**: biome runs as a separate lint pass (CLI `biome lint` on the
  changed TS/JS set), findings merged like L1.
- Defer if the lint-rule overlap with tsserver is too low to justify the plumbing.

## Resolution (grilled 2026-07-31)

**Decision: DO — add biome as a CLI-lint lane in L1, severity by domain.**

### Grounding (read `tsconfig.json` + `biome.json` + CI)

- **tsserver gap**: `tsconfig.json` is `strict: true` but has NO
  `noUnusedLocals`/`noUnusedParameters` → tsserver (current L1) does **not** catch
  unused vars/imports/params. biome's `recommended` ruleset fills exactly this
  (unused, suspicious, correctness lint). Overlap with tsserver is **low** → biome
  adds real coverage (the condition the ticket set for defer is NOT met).
- **biome already in toolchain**: every ext has `biome.json` (`linter.recommended`,
  `noExplicitAny: off`), `@biomejs/biome 2.4.16` devDep, `lint`/`check` scripts.
  biome is ALSO a CI gate (each ext's `test`/`check` chain runs `biome check`) →
  watchdog-L1-biome is early dirty-tree feedback, symmetric with
  tsserver-vs-`tsc` (L1 already duplicates CI's type-check; this extends the same
  value to lint).

### Grilled forks

- **Q1 do/defer** → DO (low overlap fills tsserver's unused gap; symmetric with
  existing L1; zero config burden; biome is fast).
- **Q2 mechanism+severity** → **CLI-lint-pass + by-domain severity** (over
  LSP-registry-entry + all-blocker).

### Spec (handoff)

1. **New L1 lane — CLI lint (NOT an LSP-registry entry).** L1 becomes two lanes:
   (i) the LSP-provider registry from 02 (`tsserver`, `pyright`); (ii) a CLI-lint
   lane. biome is the first CLI-lint entry. Rationale: the repo already invokes
   biome via CLI (`biome lint .`); biome has clean `--reporter=json`; forcing a
   linter into the LSP registry + the multi-provider-per-`.ts`-language wrinkle
   buys nothing.
2. **Invocation**: `biome lint --reporter=json` scoped to the changed TS/JS set
   (the `tsJs` L1 already computes). Resolve the binary via
   `node_modules/.bin/biome` then `PATH` (mirror `resolveTypeScriptLanguageServer`).
   Run from the subagent `cwd` so biome finds the nearest `biome.json` itself.
3. **Severity by domain** — biome rule categories map: `correctness` /
   `suspicious` / `security` → **blocker**; `style` / `complexity` / `performance`
   / `a11y` (+ `format` / import-sort) → **concern**. biome's own
   `error`/`warning` is secondary; **domain drives gate weight so style never
   blocks.**
4. **Merge**: biome findings merge into L1's findings alongside tsserver's
   (reuse the `findingFromLsp` shape: `{severity, source:"biome", path, line,
   message}`).
5. **Graceful degrade**: biome binary missing → skip the lint lane with a note
   (like tsserver `unavailable`); L1 still runs tsserver. Never a hard failure.

### Acceptance criteria (for the implementer)

- (a) `.ts` change introducing an unused import → biome flags it; severity by
  domain; surfaces as an L1 finding (tsserver alone would miss it).
- (b) Clean `.ts` change → no biome findings; no regression to tsserver L1.
- (c) biome unavailable (no binary) → lint lane skips with a note; tsserver L1
  still runs.
- (d) A correctness-rule violation (e.g. `noUnreachable`) → blocker; a style-rule
  violation → concern (never blocks).

### Graduates / defers

- **L1 two-lane model** (LSP-providers + CLI-lint) — refinement to 02's
  "generalize into a registry": 02's registry is the LSP lane; biome establishes
  a parallel CLI-lint lane. The 02/03 implementer coordinates on the two-lane
  dispatch.
- **ruff as Python lint** (deferred per 01) — now sharpened: it would be a
  CLI-lint-lane entry for Python (same shape as biome-for-TS). Still deferred
  (lower gate-signal per 01); map Not-yet-specified updated.
- **eslint** — deferred; biome is the repo's linter (no eslint in the toolchain).
