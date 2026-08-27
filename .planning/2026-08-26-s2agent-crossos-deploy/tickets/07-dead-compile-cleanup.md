---
type: task
status: closed
---

# 07 — Dead `--compile` compat-code cleanup on the deploy path

## Question

Can the ~14 source sites carrying `--compile`-mode compatibility be deleted
now that no producer builds compiled artifacts (retired 2026-08-23 #1866) —
and does their removal simplify the cross-OS work (fewer execPath/bunfs
assumptions to audit for Windows)?

## Notes for the resolver

- Recon-cited sites: `mode.ts:21` "binary" mode, `superpowers.ts:100-112`
  $bunfs detection, `spawn-subagent-subprocess.ts:60-94`, `ext-deps.ts:14`,
  `static-extensions.ts:3`, `host-modules.ts:75-78`,
  `ultracode workflow-pack.ts:156` + ADR-0003, `archify run.ts:67`.
- SAFETY: verify each site is truly dead (grep for producers of the
  "binary"/compiled shape — the 2026-08-23 effort deleted the last ones;
  retention dirs on disk are not producers). Anything with a live test
  pinned to it gets its test updated or the site kept with a citation.
- This is the effort's simplification fold-in per D1 — deploy-path sites
  only; do not scope-creep into the broader monorepo weight items.

## Resolution (2026-08-27)

**Answer: yes — every behavioral `--compile` branch is deleted; comment-only
and historical-documentation sites stay with citations.** Verified no
producer of the compiled shape remains (grep across repo; retention trees on
disk are not producers).

### Deleted (behavior + its pinned tests)

| Site | What went |
|---|---|
| `s2-agent-core-runtime/src/ext-deps.ts` | `isBunVirtualPath()` + its short-circuit branch in `missingExtDeps`; header comment rewritten with an epitaph |
| `s2-agent-core-runtime/src/index.ts` | `isBunVirtualPath` re-export |
| `s2-agent-core-runtime/src/ext-deps.test.ts` | "a compiled binary reports nothing" test (pinned the dead branch) |
| `s2-agent-core-runtime/src/spawn-subagent-subprocess.ts` | `isBunVirtual` special-case in `resolvePiInvocation` (`if (currentScript && existsSync(currentScript))` now); error message de-compiled; branch-2 comment generalized to "self-contained host" |
| `s2-agent-core-runtime/tests/spawn-subagent-subprocess.test.ts` | 2 bunfs-shaped tests rewritten to neutral nonexistent-path inputs (self-contained exec / missing entry) — same contract coverage, no dead-mode fixtures |
| `s2-agent-ext-superpowers/src/superpowers.ts` | `BUN_PI_EMBEDDED_EXTRACT_DIR` branch + `isBunBinaryUrl()` in `resolveSkillsDir`; epitaph comment records the deletion + ticket ref |
| `s2-agent-ext-superpowers/tests/binary-mode.test.ts` | whole file (tested only the dead extract-dir behavior) |
| `s2-agent-ext-archify/src/run.ts` | comment-only: `resolveRuntime` doc + `runtimeMissingMessage` no longer narrate the compiled-agent-entry scenario (behavior unchanged — ladder identical) |
| `s2-agent-ext-ultracode/src/workflow-pack.ts` | comment-only: binDir rationale no longer cites "the compiled exe's real location in `bun --compile`" |
| `s2-agent-ext-superpowers/CONTEXT.md` + `s2-agent-ext-wayfind/CONTEXT.md` | asset-resolution ladder updated: "three-mode" → "two-mode", deleted mode named with ticket ref (caught in the final repo-wide grep sweep) |

### Review round (harness `/code-review high`, 2026-08-27 — 7 confirmed findings, all addressed)

- **branch-2 of `resolvePiInvocation` deleted** (reviewer-confirmed
  unreachable in every produced configuration — all launchers exec `bun
  <bundle>`): the "non-node/bun exec IS its own entry" fallback and its 2
  pinned tests went; missing entry now throws for ANY runtime.
- **`resources_discover` existsSync guard re-pinned**: deleting
  binary-mode.test.ts had removed its only coverage — new
  bootstrap.test.ts case (nonexistent skills dir → `{skillPaths: []}`).
- **superpowers.ts:217 comment** no longer narrates the deleted mode as the
  guard's live example (mispackaged-deploy example instead); **fromUrl doc**
  now says "test seam" instead of naming a nonexistent caller class (param
  kept: demoting it below `shExtDir()` would break test injectability —
  recorded here as considered-and-kept).
- **ticket receipt corrected**: mode.ts row had claimed "binary" survives as
  a recognized mode value — false, `BundlerMode` has two members; row fixed
  to comment-only.
- **ext-deps.ts header de-duplicated**: one compile-mode narration (folded
  into the WHY paragraph) instead of two.
- **Not code defects, no action in this PR**: `scripts/claude-code-glm.sh`
  (user's local launcher tweak, deliberately excluded from the commit) and
  the untracked repo-root transcript txt (stays untracked; no gitignore
  pattern added — out of ticket scope).

### Kept WITH citation (historical/documentation value, no dead branch)

- `mode.ts` "binary" — comment-only: `BundlerMode = "bundle" | "source"`
  carries no "binary" value; the surviving paragraph is the epitaph
  explaining why the type has exactly two members.
- `static-extensions.ts` / `static-extensions-gen.ts` — static-import
  rationale comments mention the compiled mode as WHY static registration
  exists; the mechanism is alive.
- `host-modules.ts` `createRequire` comment — explains bun cjs folding,
  still true under the sh deploy.
- `registry-config.ts` $bunfs vendoring rationale — documents why vendored
  closure must not assume `node_modules` resolvable from execPath.
- ultracode `ADR-0003` — ADRs are immutable history.

### Gates (canonical, this machine 2026-08-27)

- core-runtime: `bun run check` (3 pre-existing unrelated warnings), `bun
  run typecheck` clean, `bun run test` 494 pass / 0 fail.
- superpowers: `bun run test` 165 pass / 0 fail (biome clean).
- archify: `bun run test` 699 pass / 0 fail.
- ultracode: `bun run test` 1193 pass / 0 fail (biome 62 pre-existing
  warnings untouched, tsc clean).

Net effect for the effort: the deploy path now has ONE process shape
(bundle + shipped bun via launcher) — the Windows audit surface
(execPath/bunfs assumptions) is exactly the sh-deploy contract, nothing
else.
