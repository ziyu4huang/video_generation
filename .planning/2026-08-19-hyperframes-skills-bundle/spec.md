# Spec: vendor the HyperFrames skill family into bun-apps — purge ~/.pi skills

**Effort**: `hyperframes-skills-bundle`
**Date**: 2026-08-19
**Status**: shipped (#1713, 2026-08-19; see `map.md`)

## Problem

The pi harness auto-discovers skills from ambient user-level directories (`~/.pi/agent/skills/`, `~/.agents/skills/`) and injects them into the system prompt. Today 8 HyperFrames-family skills + media-use live there as **symlinks** into `~/.claude-custom/skills/` (installed via `npx skills` from `heygen-com/hyperframes` on 2026-08-08), plus `find-skills` in `~/.agents/skills/`. This is unversioned user state: not in git, not deployed with the extensions, different across machines.

## Goal

**No skills under `~/.pi/`.** The HyperFrames family ships as a bundled `skills/` dir inside a new extension package, following the existing extension-bundled-skill pattern (power-tool). `find-skills` is discarded outright (marketplace meta-skill, low value once skills are repo-owned).

## Decisions (user-confirmed)

1. **New package `bun-apps/pi-agent-ext-hyperframes`** — the 8 skills cross-reference each other by slash-name (`/hyperframes-core`) and relative path (`../media-use/references/...`), so they must share one `skills/` root. Not folded into movie-director: hyperframes is HeyGen's Node ecosystem, different domain from the run.py MLX pipeline.
2. **find-skills discarded** — not vendored.
3. **Full verbatim vendor** (~5.5MB incl. 19 mp3 SFX, 6 woff2 OFL fonts; licenses/credits bundled inside the trees). Upstream updates = manual re-vendor (procedure in the package README).
4. **Cleanup scope**: remove the 8 symlinks in `~/.pi/agent/skills/`, remove `~/.agents/skills/find-skills`, remove the then-dangling `~/.claude-custom/skills/find-skills` symlink. `~/.claude-custom/` otherwise untouched (Claude Code's copy stays).

## Mechanism (verified)

- Source mode: `package.json` `pi.skills: ["./skills"]` + `pi-agent/run-dir/manifest.json` `skills[]`; `binarySkills[]` marks dirs whose binaries must be extracted to real disk in embedded/exe deploys (`run-dir/resolve.ts`).
- Static extension: `static-extensions.ts` import + manifest `staticExtensions[]` (set/order equality enforced by `manifest-consistency.test.ts`); the extension factory is a deliberate no-op — the package carries skills, not tools.
- Sh deploy: `deploy-config.yaml` entry with `skills: [skills]`; `sh-ext-build.ts` copies verbatim (dereferenced) into `<dist>/ext/<name>/skills/`.
- Upstream load order: user `~/.pi/agent/skills` → project `.pi/skills` → `~/.agents/skills` → explicit `--skill` paths (ext-bundled last). First name wins — user-level cleanup must complete before final verification or stale skills shadow the vendored ones.

## Acceptance criteria

- [ ] `bun-apps/pi-agent-ext-hyperframes` package: 8 skill trees vendored verbatim, no-op extension entry per the uniform `extensions/<X>.ts` convention, README provenance + re-vendor procedure
- [ ] Wired on all 4 surfaces: package `pi` manifest, run-dir manifest (`skills`/`binarySkills`/`staticExtensions`), `static-extensions.ts`, `deploy-config.yaml`
- [ ] `tests/skills-manifest.test.ts` guards roster, frontmatter (real YAML parse — descriptions are block scalars), vendoring integrity (no symlinks, binary assets present)
- [ ] All gates GREEN: package test+typecheck, pi-agent manifest-consistency+typecheck, devops sh-config, bun-apps shared gates (skills-ref, dead-export, ext-entry)
- [ ] Sh deploy build produces `ext/hyperframes/skills/` with all 8
- [ ] Fresh pi session: 8 skills from repo paths, zero `~/.pi`/`~/.agents` skills
- [ ] PR merged via devops chain; `.planning/2026-08-19-hyperframes-skills-bundle/` committed

## Risks

- ~5.5MB binaries enter git (accepted; git-lfs later if needed)
- Vendored `.test.mjs` files from upstream must not run under the package's `bun test` (script scoped to `tests/`)
- Upstream skill updates need manual re-vendor; lock-file hashes in `~/.agents/.skill-lock.json` are the provenance record
