# vendored/ — archify runtime snapshot

Vendored snapshot of **archify@2.12.0** (MIT). Self-contained — no reference to any sibling archify checkout at runtime.

- `bin/archify.mjs` is the **hand-written ESM CLI entry** (npm `bin` convention + `#!/usr/bin/env node` shebang) — **not a build artifact**. archify is plain ESM `.mjs`; there is no `.ts`→`.mjs` build step.
- The **only machine-generated** file is `renderers/shared/generated-validators.mjs` (ajv codegen from `schemas/`, regenerated via `scripts/generate-validators.mjs --check`).
- Layout mirrors archify's own tree: `bin/` + `renderers/` + `schemas/` + `delta/` + `assets/` + `scripts/` are siblings under `vendored/`, because both `bin/archify.mjs` and `renderers/shared/cli.mjs` (`loadDiagram`) resolve them via `skillRoot`. **Do not rename `bin/` or `assets/`** — `loadDiagram` reads `assets/template.html` on every render/compare; renaming breaks it.

Re-sync: re-copy from upstream archify@2.12.0. Do not edit vendored source here.
