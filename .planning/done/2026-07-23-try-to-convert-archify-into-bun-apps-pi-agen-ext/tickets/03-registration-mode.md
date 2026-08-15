## Question

Register `pi-agent-ext-archify` as **dynamic** (opt-in via `run-dir/manifest.json` `extensions[]` with a `testGate`, plus a `skills[]` entry) or **always-on static** (`src/static-extensions.ts`)?

**Recommendation:** dynamic. Matches the schema-cost discipline and the `research-tool` precedent; a creative/diagramming extension shouldn't load on every session.

**type:** grilling
**blocked by:** —
**claimed:** wayfind-session (2026-07-23) — resolving

## Resolution (2026-07-23) — CLOSED

**DECISION: Dynamic / opt-in.** archify is a capability extension (on-demand diagramming), not core infrastructure → register in `extensions[]`, never `staticExtensions[]`.

Concrete entries for `bun-apps/pi-agent/run-dir/manifest.json`:

- **`extensions[]`** — add object:
  ```json
  {
    "name": "pi-agent-ext-archify",
    "entry": "pi-agent-ext-archify/extensions/archify.ts",
    "bundleMode": "thin",
    "testGate": "cd bun-apps/pi-agent-ext-archify && bun test",
    "version": "0.1.0"
  }
  ```
- **`skills[]`** — add `"pi-agent-ext-archify/skills"`.
- **`binarySkills[]`** — **NOT added** (the condensed skill is pi-native / editable, not a byte-identical upstream port — same posture as research-tool / obsidian).
- **`staticExtensions[]`** — **NOT added** (would double-register + bake into every deploy + load every session).
- **CLI subcommand** — **none** (we chose tools, not a CLI bridge; revisit only if headless use emerges).

**Rationale:** matches the research-tool / flux2 / movie-director precedent; keeps archify off the always-on context budget (schema-cost discipline); `thin` aligns with the deploy research in [02](02-deploy-bundling-of-vendored-assets.md) — THIN follows ESM imports, so vendored `.mjs` + `import`ed schemas inline cleanly. `testGate` is `bun test` regardless of the 04 testing-strategy outcome (the TS wrappers always have a bun suite); 04 only decides whether archify's own `node --test` suite ALSO runs.

**Unblocks:** [07 CI wiring](07-ci-wiring.md) — the testGate is now `bun test`, so the branch-protection required-check question is answerable (add `test · pi-agent-ext-archify` as required once green).
