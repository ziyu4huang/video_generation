## Task 5: Docs (README + PRD)

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/README.md`
- Modify: `bun-apps/pi-agent-ext-power-tool/PRD.md`

- [ ] **Step 1: README — add inspect_hooks to the Tools list**

In the README's tools listing (alongside `inspect_extensions`), add an entry:

```markdown
- `inspect_hooks` — list every loaded extension's registered `pi.on(...)` lifecycle
  hooks (which events each extension listens on, handler counts) and flag any handler
  registered against an unknown event name (likely a typo / dead handler). Fact-finder
  companion to `inspect_extensions`. Params: `by_event` (group by event), `return_json`,
  `self_test`.
```

- [ ] **Step 2: PRD — note the new tool + the phase-2 (firing counts) follow-up**

In `PRD.md`, under the inspect-* section, add a short subsection:

```markdown
### inspect_hooks

Hook observability for extension development — the last blind spot of the
inspect surface. Phase 1 (this work): registration listing + `unknown-event-name`
typo detection, reading the aggregated `runner.extensions[].handlers` via a
`getHooks()` polyfill on `sdk-patch.ts`'s `createContext` wrapper.

Phase 2 (follow-up plan, same effort): firing counts — wrap each handler with a
counter at the same patch point, add the `never-fired` (registered-but-dead)
finding. The patch point is shared, so the scaffolding lands once in phase 1.
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/README.md bun-apps/pi-agent-ext-power-tool/PRD.md
git commit -m "docs(power-tool): document inspect_hooks tool + phase-2 follow-up"
```

---

## Self-Review

**1. Spec coverage** — every D-decision and phase-1 requirement maps to a task:
- D1 fact-finder → Task 1 (analyzeHooks = pure facts + conservative severities). ✓
- D2 all-events surface + by_event + KNOWN_EVENTS reference → Task 1 (KNOWN_EVENTS, analyzeHooks inventories all, formatHooksReport `byEvent`). ✓
- D3 text + JSON → Task 3 (return_json branch). ✓
- D4 unknown-event-name (medium) + hook-stats (info) → Task 1 analyzeHooks. (never-fired is phase-2, explicitly out of scope.) ✓
- D5 phase-1 only (no handler-wrapping) → Tasks 1–4 read the aggregate only; no runtime behavior change. ✓
- D6 independent graceful fail → Task 2 (getHooks own try/catch; getSystemPromptOptions unaffected; test asserts independence). ✓
- Files table (sdk-patch / new tools file / index +1 line / tests / README+PRD) → Tasks 1–5. ✓
- Verification (typo detected, graceful degradation, self_test deterministic) → Tasks 1 & 3 tests + Task 4 gate. ✓

**2. Placeholder scan** — no TBD/TODO/"add error handling"/"similar to Task N". The Task 1 `makeInspectHooksTool` placeholder is explicitly labeled and fully replaced in Task 3 (Step 3). ✓

**3. Type consistency** — `HooksSnapshot`/`ExtensionHooks`/`HookRegistration`/`Finding`/`Severity` defined once (Task 1) and used identically in Tasks 2–3. `collectHooks` signature `unknown → HooksSnapshot` matches both the Task 2 polyfill call and Task 1 tests. `applyContextPolyfills(ctx, PolyfillRunner)` matches the Task 2 test. `ctx.getHooks(): HooksSnapshot` (augmentation) matches the Task 3 `(ctx as ExtensionContext).getHooks()` call. ✓

No issues found — plan is complete and internally consistent.
