---
type: grilling
blocked by: []
status: closed
claimed: wayfind-session (2026-07-31)
resolved: 2026-07-31 (DO — globalThis-keyed singleton + version token; both singletons)
---

# 09 — Decide: Cross-ext singleton identity handshake

**Source**: 02#1 · axis `robustness` · **Impact 5 / Effort 3 / score 15** (rank 5)

## Question

Decide do/defer/skip + spec for the cross-extension singleton sharing risk
(silently-invisible subprocess-spawned runs).

## Resolution (grilled 2026-07-31, branch behind:3, 0 touched subagent/workflow src)

**Decision: DO** — eliminate divergence at the source via a **globalThis-keyed
singleton + version token guard**, applied to **both** at-risk singletons.

**Facts found (not asked)**: `_registrySingleton` is a module-scoped lazy-init
(`subagent-in-flight.ts`); the sharing contract is **convention-only** — the
docstring says "Importers MUST use the src subpath so both extensions resolve the
same module instance," with **zero runtime enforcement**. `runObsidianSubagent`
passes the parent process's registry instance into `spawnSubagentSubprocess`
(phantom registration in the parent); the viewer reads in the parent too. Divergence
= two module-graph copies of the package in one process (dupe install, bundler copy,
symlink loop, future pi loader change) → register in instance A, viewer reads B →
**result silently invisible**. `getSubagentRunPersistence()` has the identical shape
and identical risk.

### Grilled forks

1. **Approach** (Q1) → **prevent** (globalThis-keyed singleton) over detect-and-warn
   / detect-and-fail / defer. Prevents divergence entirely rather than just making it
   observable; same line count.
2. **Version guard** (Q2) → **include** a version token (robustness, consistent with
   the "prevent" choice; cheap insurance against two package versions coexisting in
   one process).

### Spec (handoff)

1. **Mechanism** — replace the module-scoped `_registrySingleton` lazy-init with a
   `globalThis`-keyed slot, so every module-graph copy in the process reads/writes
   one slot:
   - in-flight: `globalThis[Symbol.for("@repo/pi-agent-ext-subagent/in-flight-registry")]`
   - persistence: `globalThis[Symbol.for("@repo/pi-agent-ext-subagent/run-persistence")]`
2. **Version token guard** — store `{ instance, version }`; `version` is a
   **singleton-shape constant** (e.g. `SINGLETON_REGISTRY_VERSION = "1"`), bumped
   when the registry's stored shape changes (NOT the package semver — bundler-safe).
   On read: slot present but `version` mismatched → `console.warn` both versions +
   replace with a fresh current-version instance; slot absent → init.
3. **Scope** — convert **both** `getSubagentInFlightRegistry()` and
   `getSubagentRunPersistence()` (same pattern, same risk).
4. **Test reset hooks** — add `__resetSubagentInFlightRegistryForTests()` /
   `__resetSubagentRunPersistenceForTests()` that delete the globalThis slot, for
   test isolation (repo values hermeticity/determinism — see 02's closed
   test-hermeticity cluster).
5. **Docstring correction** — update the "MUST use src subpath" note to
   "globalThis-keyed → module-instance divergence impossible; src subpath still
   preferred for module-graph hygiene" so it stops overstating the load-bearing
   convention.

### Acceptance criteria (for the implementer)

- (a) Test: two simulated module-graph copies both call `getSubagentInFlightRegistry()`
  and assert they receive the **same instance** (the regression this whole ticket
  exists to prevent).
- (b) Test: a slot pre-seeded with a mismatched `version` triggers a warn + returns a
  fresh current-version instance (the Q2 guard).
- (c) Both singletons converted; reset hooks exported and used by the existing test
  suites; no new test-isolation regressions.

**No new ticket graduates** from this resolution — the spec is execution-complete;
implementation is handoff (wayfinder is planning, not building).
