## Question

Does archify's vendored `.mjs` render path (render + validate + delta) run cleanly under the **Bun** runtime, and what Node/browser-API surface does it touch — *excluding* the browser-launching `bin/preview.mjs` and `bin/open-artifact.mjs`?

This is the load-bearing fact under the "vendor the `.mjs` as-is" decision: if the render path leans on Node-only or browser APIs that Bun breaks (or that can't run headless), ingestion needs patches, not a plain copy.

**type:** research
**blocked by:** —

## Resolution (research pass, 2026-07-23) — CLOSED

**VERDICT: RUNS CLEAN under Bun — no patches needed for the render / validate / delta path.**

All 5 renderer types rendered under `bun bin/archify.mjs render <type> <sample.json> <out.html>` (577–586 KB each). Node-API surface in the render path is fully Bun-compatible: `node:child_process` (spawnSync), `node:crypto`, `node:fs`, `node:os`, `node:path`, `node:url`, plus `import.meta.url` for `__dirname`. **No browser APIs**; **no transitive deps beyond `ajv`** (and `ajv` isn't even imported in the render path — only referenced for an optional degraded mode). No Bun-specific surprises.

**Caveat (not blocking):** `renderers/shared/repository-evidence.mjs` uses `spawnSync` to spawn `node`/`git` for the *optional* 'inspect repository evidence' feature — fine on a dev box with `node` on PATH; if repo-evidence is ever wanted in a node-less runtime, that one file needs a bun-aware spawn. Authored-IR render/validate/delta are unaffected.

→ A pi tool can wrap archify either by **importing the renderers directly** or by **shelling out to `bin/archify.mjs`**; both work under bun.
