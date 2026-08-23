# Plan: purge skills from ~/.pi — vendor hyperframes skill family into a new bun-apps extension

## Context

The pi harness auto-discovers skills from standard dirs and injects them into the system prompt. Today skills surface from 4 sources: project `.pi/skills/` (repo-owned, fine), user `~/.pi/agent/skills/` (8 skills — **all symlinks** into `~/.claude-custom/skills/`, installed via `npx skills` from `heygen-com/hyperframes`), cross-agent `~/.agents/skills/` (find-skills), and extension-bundled skills (power-tool — the target pattern).

**Goal (user decisions confirmed):**
1. New extension package `bun-apps/pi-agent-ext-hyperframes` hosting the 8-skill family (7 hyperframes + media-use) — they cross-reference each other by slash-name and `../media-use/...` paths, so they must stay in one `skills/` root.
2. `find-skills` is **discarded** (not bundled).
3. Full vendor copy into the repo (~4MB incl. 20 mp3 SFX, .woff2 OFL fonts — licenses/credits are already bundled inside the skills).
4. Cleanup scope: remove the 8 symlinks in `~/.pi/agent/skills/` + `~/.agents/skills/find-skills`; `~/.claude-custom/` otherwise untouched.

## Mechanism (verified during exploration)

- **Source layout**: `<pkg>/skills/<name>/SKILL.md` (+ refs/scripts/assets), declared as `"pi": { "skills": ["./skills"] }` in package.json (power-tool reference: `bun-apps/pi-agent-ext-power-tool/package.json:15-22`).
- **Run-dir mode**: `bun-apps/pi-agent/run-dir/manifest.json` — `skills[]` (line 48) lists `<pkg>/skills` paths; `binarySkills[]` (line 59, must be subset of `skills[]`) marks dirs whose binaries must be extracted to real disk in embedded/exe deploys (`run-dir/resolve.ts:127`, `scripts/generate-embedded-assets.ts:69`); `staticExtensions[]` (line 65) for always-on packages.
- **Sh deploy**: `bun-apps/pi-agent/deploy-config.yaml` per-ext entry with `skills: [skills]`; `pi-agent-ext-devops/scripts/lib/sh-ext-build.ts:187-190` copies skills verbatim (dereference) into `<dist>/ext/<name>/skills/`, recorded in `ext.json`; at runtime `pi-agent/src/sh/ext-loader.ts:134-137` → `cli-sh.ts:62` turns them into `--skill` argv.
- **Upstream discovery order** (pi-coding-agent 0.84.2 `core/skills.js:291`): user `~/.pi/agent/skills` → project `.pi/skills` → `~/.agents/skills` (user) → explicit `--skill` paths (ext-bundled). Removing the user-level entries + not shipping find-skills leaves only project + ext-bundled skills.

## Implementation steps

### 1. Vendor content → `bun-apps/pi-agent-ext-hyperframes/skills/`

Copy (dereference symlinks) the 8 trees from `~/.claude-custom/skills/`:
`hyperframes`, `hyperframes-cli`, `hyperframes-core`, `hyperframes-registry`, `hyperframes-creative`, `hyperframes-keyframes`, `hyperframes-animation`, `media-use`.

```bash
for s in hyperframes hyperframes-cli hyperframes-core hyperframes-registry hyperframes-creative hyperframes-keyframes hyperframes-animation media-use; do
  cp -R ~/.claude-custom/skills/$s bun-apps/pi-agent-ext-hyperframes/skills/$s
done
```
(Do NOT copy `find-skills` or the dangling `playwright-cli` symlink.)

### 2. Package skeleton (mirror power-tool)

- `package.json`: `@repo/pi-agent-ext-hyperframes`, private, `"main": "./src/index.ts"`, `pi` manifest `{ "extensions": ["./extensions/hyperframes.ts"], "skills": ["./skills"] }`; deps: `@earendil-works/pi-coding-agent@0.84.2`, `@repo/pi-agent-core-interface` (workspace:*).
- `extensions/hyperframes.ts`: minimal no-op extension (default export registering nothing — the package ships skills, not tools; keeps every deploy pipeline's code path working). Follow the CLAUDE.md entry rule (entry at `extensions/<X>.ts`, never src/index.ts as registration).
- `src/index.ts`: lib re-export face (per src-entry convention).
- `README.md`: provenance — vendored from `heygen-com/hyperframes` (plugin "core-skills"), install date 2026-08-08, folder hashes from `~/.agents/.skill-lock.json`; note re-vendor procedure (re-run `npx skills add`, re-copy).
- `tsconfig.json` per sibling packages.

### 3. Wiring (3 registration surfaces)

- `bun-apps/package.json` workspaces: add `pi-agent-ext-hyperframes` (workspace list is explicit — see #1712 diff).
- `bun-apps/pi-agent/run-dir/manifest.json`:
  - `skills[]` += `"pi-agent-ext-hyperframes/skills"`
  - `binarySkills[]` += same (mp3/woff2/scripts binaries — extraction requirement)
  - `staticExtensions[]` += `"pi-agent-ext-hyperframes"`
- `bun-apps/pi-agent/src/static-extensions.ts`: add the static entry (same pattern as obsidian/power-tool).
- `bun-apps/pi-agent/deploy-config.yaml`: add `name: hyperframes` entry with `skills: [skills]` (validate via `sh-config.ts`).

Then `( cd bun-apps && bun install )`.

### 4. Tests (new package + gates)

- `bun-apps/pi-agent-ext-hyperframes/tests/skills-manifest.test.ts`: every dir under `skills/` has `SKILL.md`; frontmatter `name` matches dir name; `description` non-empty; the 8 expected names present; no `disable-model-invocation` regressions; binary assets (mp3/woff2) present for media-use/creative (guards against partial vendor).
- Run existing gates: `bun-apps/pi-agent/run-dir/manifest-consistency.test.ts` (binarySkills ⊆ skills), cross-package typecheck (`bun run --cwd bun-apps/pi-agent typecheck` or the repo's canonical test:pi-agent gate), schema-cost canary auto-measures the now-registered extension.
- Sh-deploy build check: run the deploy-sh build for the new ext and confirm `<dist>/ext/hyperframes/skills/` contains all 8.

### 5. User-level cleanup (destructive — only after step 4 verified GREEN)

- `rm` the 8 symlinks in `~/.pi/agent/skills/` (leave the dir; discovery is purely directory-based, empty = no user skills).
- `rm -rf ~/.agents/skills/find-skills` (discarded).
- Remove the now-dangling `~/.claude-custom/skills/find-skills` symlink (its target is gone; find-skills is globally discarded). Everything else in `~/.claude-custom/` untouched.
- Pre-existing dangling `~/.claude-custom/skills/playwright-cli` — leave (out of scope), mention in PR notes.

### 6. Process / DevOps

- Planning artifacts: commit under `.planning/2026-08-19-hyperframes-skills-bundle/` (spec.md + this plan) per standing rule.
- Branch prep, local CI, PR, merge via the devops tool chain (`prepare_branch` / `local_ci` / `await_pr_merge`) — never hand-rolled git/gh phases. local_ci must stay ≤5 min.

## Verification (end-to-end)

1. `( cd bun-apps/pi-agent-ext-hyperframes && bun test )` — GREEN.
2. `( cd bun-apps/pi-agent && bun test )` — manifest-consistency GREEN.
3. Cross-package typecheck GREEN.
4. Start a fresh pi session from the repo (`bun bun-apps/pi-agent/src/cli.ts`): system prompt `<available_skills>` lists all 8 hyperframes skills with repo paths (`bun-apps/pi-agent-ext-hyperframes/skills/...`), and **no** user-level (`~/.pi/...`) or `~/.agents/...` skills remain. `src/sh/ext-list.ts` skillPaths shows the new dir.
5. Sh-mode: built dist `pi-agent-sh` session shows the 8 skills under `ext/hyperframes/skills/`.
6. Spot-check a skill body renders: e.g. read `/hyperframes` router skill — cross-refs (`/hyperframes-core`, `../media-use/references/...`) resolve within the same vendored root.

## Risks / notes

- ~4MB of binaries enter git (mp3, woff2). Acceptable per user decision (option: git-lfs later if repo bloat matters).
- First-name-wins collision rule: if any stale user-level skill survives cleanup, it shadows the ext-bundled one — step 5 must precede final session verification.
- External runtime deps (Node 22+, FFmpeg, `heygen` CLI, Python) are unchanged — vendoring moves knowledge, not the toolchains.
- Upstream updates require manual re-vendor; README documents the procedure.
