# 04 — Corpus-builder generalization (evaluate.ts registrar manifest) — fog

type: research
claimed:
blocked by: none

## Question

`qa/evaluate.ts` builds `CORPUS_GATES` / `CORPUS_EFF` by statically importing ~20
extension entries + 4 stub registrars (`zaiRegistrar`, `hermesMemoryRegistrar`,
`coreTaskRegistrar`, `webuiPresentRegistrar`) and running a 20-entry registrar list
through `captureOwnerDeclaredDefs`. This is the harder half of generalization: the
probe side (tickets 01–03) has a clean "derive from the registry" answer, but the
corpus side must *drive* each extension's registrar to capture owner-declared defs —
registrars are imperative, not declarative.

Investigate (fog — no code yet):
- Can each extension expose a declarative `CORPUS_REGISTRARS: Array<(pi) => void>`
  (or a manifest entry) so `evaluate.ts` stops hand-listing them, mirroring how
  `__GATE_PROBES__` collapsed into `GATE_PROBES`?
- The 4 stub registrars exist because some registrars need synthetic deps
  (zai's dynamic MCP, hermes's stub store/repo, webui's server boot). Is a
  per-extension `CORPUS_REGISTRARS` enough to express those, or do the stubs stay
  in tool-gate by necessity?

**Graduates** only after tickets 01–03 show the "shared-package registry" pattern
holds for declarative data (probes). The imperative registrar list may be
fundamentally irreducible — in which case this ticket closes with a documented
"kept bespoke by necessity" verdict, and the effort still counts the probe-side
generalization as the win.

## Resolution

(open)
