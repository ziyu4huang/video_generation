> STATUS: DONE — archived 2026-08-15 (triage verdict: pi-agent-ext-archify scaffolded; deck-builder #1037)
# Map — convert archify into bun-apps/pi-agent-ext-archify

## Destination

A pi agent extension package `bun-apps/pi-agent-ext-archify/` that lets the pi agent author typed-JSON-IR technical diagrams (architecture / workflow / sequence / data-flow / lifecycle) and render them to self-contained, validated HTML — vendoring archify's `.mjs` renderers + 6 JSON schemas as a **pinned snapshot** (no TS rewrite), exposing three tools (`archify_render`, `archify_validate`, `archify_delta`), and shipping a *condensed* authoring skill that loads deep IR-guidance **on demand** instead of the full 72 KB. Reaching the end of this map = every decision blocking that build is resolved, and someone can write a plan + scaffold the package.

## Notes

**Settled scope (pinned by grill Q1–Q4 — record as an ADR when execution starts):**

- **Shape:** Hybrid — vendored `.mjs` + tools + a *trimmed* skill (not a TS rewrite, not a CLI-only bridge).
- **Ingestion:** Vendor-copy a pinned snapshot of `archify@2.12.0`'s runtime **and skill** subset into the package: `renderers/`, `schemas/`, `bin/archify.mjs`, `shared/`, **the full `SKILL.md`** (for the condensed skill's on-demand load), and **sample IRs / golden reference fixtures** — plus `LICENSE` + `based_on` credit. We own the copy; re-sync is a deliberate manual re-copy, never automatic.
- **Self-contained (hard constraint — user directive, 2026-07-24):** `pi-agent-ext-archify` has **ZERO reference back to the original `../archify` codebase** — no path, symlink, import, or runtime lookup. Everything it touches at runtime OR in the skill (renderers, schemas, `bin`, the full `SKILL.md`, sample IRs, golden reference HTML) lives **inside the package**. The original repo is the source of the one-time snapshot only; after vendor-copy it is never consulted. The render tool shells out to the **package-local** `bin/archify.mjs` (or imports the local renderers), never `../archify`.
- **Tool surface (v1):** `archify_render` (IR→HTML), `archify_validate` (IR↔schema diagnostics), `archify_delta` (two IR snapshots → before/delta/after). The merge-review / delta use case is in scope for v1.
- **Skill:** Condensed few-KB pi skill (6 diagram types, common IR shape, one minimal valid IR per type, the author→validate→render→delta loop) that points at the vendored full `SKILL.md` + schemas to `read` on demand. Never the 72 KB wholesale.

**Domain / facts:** archify is dep-light (devDeps: `ajv` only); PNG/SVG/WebM export is client-side in the produced HTML (no puppeteer/playwright). `../archify` is a sibling git repo (MIT, `private:true`). `pi-agent-ext-research-tool` is the structural precedent (tools + ported skills + `lib/`, registered via `run-dir/manifest.json` with a `testGate`). Branch is 9 commits behind `origin/main` (verified 2026-07-24: none of the 9 touch `.github/`, `run-dir/manifest.json`, or `static-extensions.ts` — CI / registration / test conventions identical to main). Rebase still advised before any code lands.

**Skills every session should consult:** `grilling` + `domain-modeling` (record the ADR); `writing-skills` (the condensed skill); `verification-before-completion` (before claiming the vendor snapshot runs / deploys).

**Standing prefs (repo):** biome `format`→`check` before push; squash-merge only; never `git checkout main` from a feature worktree (main lives in `__pi`); enumerate exact `git add` paths (never `-A`).

## Decisions so far
<!-- the index — one line per closed ticket: enough to judge relevance, then open the link for the detail -->

- [Verify vendored runtime under Bun](tickets/01-verify-vendored-runtime-under-bun.md) — **RUNS CLEAN**: all 5 renderers render under `bun bin/archify.mjs render`; Node-only API surface is fully Bun-compatible; no patches; no deps beyond `ajv`.
- [Deploy bundling of vendored assets](tickets/02-deploy-bundling-of-vendored-assets.md) — **CLEAN with one rule**: `import` JSON schemas (don't `fs.readFile` them) so THIN bundling captures them; `--snapshot` copies everything; package needs `exports`/`files` for `vendored/`. (Also corrects a stale prior: FULL bundles were removed; modes are now THIN + `--snapshot`.)
- [Registration mode](tickets/03-registration-mode.md) — **Dynamic / opt-in**: `extensions[]` object (`thin`, `testGate` `bun test`), `skills[]` yes, NOT `binarySkills[]` / `staticExtensions[]`, no CLI subcommand. Unblocks [07 CI wiring](tickets/07-ci-wiring.md).
- [Testing strategy](tickets/04-testing-strategy.md) — **Bun-only, single runtime**: discard archify's 64 `node --test` files (don't vendor `test/`); re-implement a bun golden snapshot (render via `bun bin/archify.mjs`, not `node`); TS wrapper tests in bun; keep `check:validators` ajv gate under bun; testGate stays `bun test` (per 03). Accepts losing renderer-internal coverage (relies on golden snapshot + wrapper tests).
- [Condensed skill outline](tickets/06-condensed-skill-outline.md) — **~3 KB base** (frontmatter, type-choice, IR skeleton + shared vocab, 2-line layout essentials, ONE architecture example, the validate→render→delta loop, LOCAL on-demand pointers) + on-demand depth (full layout / per-mode / Mermaid / repo-evidence / schemas) read from `vendored/`. Agent authors raw JSON IR validated at runtime → **Typebox tool-inputs ruled out** (clears that fog).
- [Default output location](tickets/05-default-output-location.md) — **cwd default**: `outputPath` param → IR `meta.output` → fallback `<diagram_type>.html` (collision-safe); tool writes file + returns absolute path. Vault deferred (fog) — 580 KB HTML = standalone deliverable, not vault-note material; `resolveVaultRoot` footgun.
- [CI wiring](tickets/07-ci-wiring.md) — **Required from day 1**: matrix row `pi-agent-ext-archify` (`bun test`) + CI.md `contexts[]` + server-side branch-protection (`gh api` PUT **full** body, granular sub-endpoint 404s here); all land WITH scaffold. Routing is automatic — `ci-changed-packages.sh` globs `bun-apps/*`, verified archify auto-discovered once `package.json` exists; check no-ops on non-archify PRs. No change to the routing script or manifest.

## Not yet specified
<!-- in-scope fog — not yet sharp enough to ticket; graduates as the frontier advances -->

- **Vault integration for artifacts (deferred fast-follow).** Default is now cwd (settled in [05](tickets/05-default-output-location.md)). Vault-aware output via `OB_VAULT_PATH` is a possible fast-follow, but a ~580 KB interactive HTML is a standalone deliverable (not vault-note material) and `resolveVaultRoot` carries the silent-cwd-fallback footgun — only worth a dedicated ticket if vault embedding becomes a real need.
- **Interactive preview / open-artifact handoff.** `bin/preview.mjs` + `bin/open-artifact.mjs` launch a browser; under headless pi they need a different handoff (e.g. open the produced HTML in the user's browser). Decide once the render tool exists.
- **Re-sync workflow for the vendored snapshot.** How/when to pull a newer archify into the vendored copy. Only matters once upstream moves — leave as fog.

## Out of scope
<!-- ruled beyond the destination -->

- **Deep TS rewrite / full absorption** of archify into a native workspace package (ruled out in Q1; the `.mjs` is vendored as-is).
- **CLI-subcommand bridge** (`pi archify …`) as the primary surface (ruled out in Q1; we expose tools, not a CLI bridge). A thin `archify_cli` passthrough may return as a fast-follow if batch/headless use emerges.
- **Ongoing upstream tracking via git submodule** (ruled out in Q2; we vendor a pinned snapshot).
- **Publishing archify as a standalone npm package** (archify is `private:true`; this effort integrates it into pi, not redistributes it).
