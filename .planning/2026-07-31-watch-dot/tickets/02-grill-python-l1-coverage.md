---
type: grilling
blocked by: [01]
status: closed
claimed: wayfind-session (2026-07-31)
resolved: 2026-07-31 (DO — generalize L1 into a multi-provider registry; add pyright for Python)
---

# 02 — Decide: add Python to L1 coverage

## Question

Decide `do / defer / skip` + mechanism for giving Python edits L1 coverage (currently
TS/JS-only → this repo's Python ML pipeline is silently unreviewed).

## Resolution (grilled 2026-07-31, branch behind:0)

**Decision: DO — generalize L1 into a multi-provider registry, add Python (pyright) as
the second provider.**

### Grounding (read `lsp-diagnostics.ts`)

`JsonRpcLspClient` is **already language-agnostic** (standard LSP: `initialize` →
`initialized` → `didOpen`+`didSave` → wait for `publishDiagnostics`). Only **three
small things are TS/JS-specific**: `TS_JS_EXTENSIONS` (ext→languageId map),
`resolveTypeScriptLanguageServer` (provider resolver), and `PROVIDER_NAME`. ⇒
"generalize" abstracts **config**, not the protocol client — cheaper than it looks.

### Grilled fork

- **Mechanism** (Q1) → **generalize** (provider registry) over bolt-on / defer. The
  client core is reusable; abstracting the provider/language config is the smaller
  part, and it unblocks 03 (biome) + future languages as mere registry entries.

### Spec (handoff)

1. **`L1Provider` interface + registry** —
   `{ name, languageIdFor(ext), resolveCommand(root): LspCommand | undefined }`. A
   registry holds entries: `[tsserver (TS/JS), pyright (Python)]`.
2. **Refactor, don't rewrite** — fold the existing `TS_JS_EXTENSIONS` +
   `resolveTypeScriptLanguageServer` into the **tsserver provider entry** (the TS/JS
   path becomes "just another entry"). `JsonRpcLspClient` is **not modified**.
3. **Dispatch + merge** — `runLspDiagnostics` groups changed files by provider, runs
   each provider's LSP via the unchanged client, merges findings (existing
   `findingFromLsp` severity map reused: LSP `error`→blocker, `warning`→concern).
4. **Provider: pyright** (`pyright-langserver --stdio`). **basedpyright** as a
   configurable alternative — defer the pyright-vs-basedpyright pick to implementation
   (try both against the repo; defaults differ).
5. **⚠️ Prerequisite (verify before impl)** — pyright **venv / extraPaths** config:
   must resolve `python/venv` + sibling-fork deps (`../mflux`, `../ltx-2-mlx`). Confirm
   whether a `pyrightconfig.json` / pyproject section is needed, or pass via LSP
   `workspace/configuration`. If pyright can't resolve cleanly, revisit this ticket.

### Acceptance criteria (for the implementer)

- (a) `.py` change → L1 runs pyright, Python diagnostics surface as blocker/concern
  (the regression this ticket exists to fix).
- (b) `.ts` change still routes to the tsserver provider — **no regression** to TS/JS.
- (c) Mixed `.py` + `.ts` changes → both providers run, findings merged.
- (d) Registry is additive: a 3rd provider (e.g. 03 biome) is a new entry, no client
  change.

### Graduates / defers

- **03 (biome)** stays blocked-by-02 → now unblocked (reuses the registry).
- **ruff as a 2nd Python source (lint)** — lower gate-signal per 01; deferred (would be
  a new ticket parallel to 03, trivially addable once the registry exists).
- **Further languages (Rust/Go)** — deferred; now just "a new registry entry" if ever
  wanted (see map Not-yet-specified, sharpened).
