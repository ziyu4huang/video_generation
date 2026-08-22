# Spec — deploy-platform-neutral-core

Effort: `.planning/2026-08-23-deploy-platform-neutral-core/` · map: `map.md`

## 1. Problem

The sh deploy's core is a `bun build --compile` Mach-O binary. That choice pulled in a
whole class of compiled-binary-only traps (import.meta/$bunfs folding, `__dirname`
rebinding, `execPath`-based self-location, baked-path scans, embedded-asset baking) and
ties every artifact to one platform: a Linux target cannot reuse anything the pipeline
produces. Meanwhile the extension half of the deploy already ships as plain
`ext/<name>/ext.cjs` bundles — text, relocatable, platform-neutral — and is loaded at
runtime by whatever host runs it.

The observation: the core can ship the same way. `bun` itself is the only
platform-specific piece, and it is one file we can copy next to the bundle.

## 2. Measured feasibility (2026-08-23 spike, bun 1.4.0)

All numbers reproduced from `/tmp/s2agent-cjs-spike/`; methodology inline in map.md
Context. Summary of what the spike proved and what it broke:

| Question | Result |
| --- | --- |
| `--format=cjs` bundle of `src/cli-sh.ts` | parse error — top-level `await` at `cli-sh.ts:88` |
| ESM `--target=bun --minify` bundle | 2,542 modules / 126 ms / 6.18 MB |
| boots + `--ext-list` with ext dir override | 17/17 loaded, 0 skipped |
| `--version` with `package.json` beside bundle | correct (`0.2.3+g06dbb2e`) — packageDir works |
| bare boot (no override) | extRoot silently `~/.bun/bin/ext`, 0 extensions |
| `import.meta.dir` inside the bundle | = bundle's own directory (survives) |
| `doctor --json` on the bundle | mode misreported `source`; entry check FAILS |
| embed-manifest build | +19 hashed sidecar asset files, 6.9 MB total, boots 17/17 |
| `process.execPath` (the bun to ship) | 63.5 MB → new core total ≈ 70 MB vs 71 MB today |

## 3. Decisions

- **D1 — the core ships as an ESM `.js` bundle.** Top-level await rules out CJS, and bun
  runs ESM natively. The file is named `s2-agent.js` at the version-dir root (beside
  `package.json`, matching where the compiled binary sat). Extension `ext.cjs` bundles are
  untouched — different producer, different loader.
- **D2 — bundle-mode self-anchoring inside `cli-sh.ts`.** Replace the unconditional
  `dirname(process.execPath)` with: compiled mode (execPath IS the app / `import.meta.url`
  is `$bunfs`-virtual) → today's behavior; bun-run bundle mode → anchor on the entry's own
  directory (`import.meta.dir` measured to survive bundling); `PI_AGENT_SH_EXT_DIR`
  override keeps precedence. The same anchor logic fixes `doctor.ts`'s deployDir/entryPath,
  and doctor's coarse mode grows a third bucket so the new shape reports honestly instead
  of as `source` with a failing entry check. The launcher must NOT be load-bearing: bare
  `bun s2-agent.js` from inside the deploy dir loads extensions correctly.
- **D3 — `bin/bun` is a copied, content-cached platform artifact.** `<stage>/bin/bun` is a
  copy/hardlink of `process.execPath`, cached under `<outRoot>/.buns/<hash>/bun` keyed on
  (Bun.version, platform, arch) exactly as `.cores` keys the core on its build inputs.
  Platform neutrality is a property of the bundle; swapping `bin/bun` for another
  platform's same-version bun is the documented cross-platform path. No cross-compile
  targets in this effort.
- **D4 — the launcher is renamed `s2-agent.sh`; `run.sh` stays as a one-line exec shim.**
  The name now matches the repo-root entry point and says what it launches. The shim keeps
  existing muscle memory and any external reference working for one retirement cycle; it
  is marked deprecated in a comment and can be dropped in a later effort. The body keeps
  every existing behavior: SCRIPT_DIR resolution, `JITI_FS_CACHE`, dashed
  `S2-AGENT_CODING_AGENT_DIR` via `env`, the system-Chrome probe — only the final `exec`
  line changes to `"$SCRIPT_DIR/bin/bun" "$SCRIPT_DIR/s2-agent.js"`.
- **D5 — `.cores` generalizes from one file to a directory tree.** The bundle emit is
  multi-file (`s2-agent.js` + 19 hashed assets), so `computeCoreHash` inputs gain the
  `--target=bun` flag (output-affecting) and `ensureCachedCore`/`linkCore` hardlink every
  file of the cached tree into the version dir (per-file hardlinks, like ext/ files). The
  freeze/no-freeze inode caveat carries over unchanged.
- **D6 — embedded assets ship as sidecar files, layout-preserving.** The hashed asset
  names bun emits are content-derived and referenced by the bundle; the deploy stages the
  whole outdir as `<stage>/assets/`-flat or beside the bundle (ticket 01 picks whichever
  `import.meta`-relative resolution in the generated manifest actually reads — measured to
  boot 17/17 with them in the same directory as the entry, so same-dir is the default).
  Gate 5a/5c/5d and Gate 6 relocation cover them like any other tree file; the generated
  embed manifest and the codegen reset (embed → empty) stay exactly as the compiled path
  had them.

## 4. Explicitly out of scope

- Cross-compiling or downloading per-platform buns (`--target=bun-linux-*` builds,
  multi-platform dist matrices).
- Changing the extension bundling pipeline (`ext-build.ts`) in any way.
- Reopening the 2026-08-20 consolidation (no second pipeline; the compiled mode is
  REPLACED, not added beside).
- Bundler updates beyond what the artifact change forces.

## 5. Risks / open questions

1. **Upstream (pi) code paths that assume compiled mode** beyond doctor —
   `scrub-inherited-package-dir.ts`, anything keying on `$bunfs` or `execPath`. Ticket 01
   sweeps `s2-agent/src` for those anchors; each hit is either given the D2 bundle-mode
   branch or proven inert with a boot probe.
2. **Gate 5b false positives on the pristine bun binary** — first gated deploy decides;
   new allowlist entries are expected and must be justified in the allowlist table
   (`offline-gate.ts`), not blanket-suppressed.
3. **Hardlink semantics with `freezeTree`** already solved for `.cores` files; the
   multi-file generalization must preserve it (per-file links, same chmod story).
4. **deploy-report / deploy.json consumers** read `core.bytes` / `core.cached` — semantics
   extend naturally (bundle+assets bytes; bun tracked as its own row).

## 6. Test strategy

- **Spike receipts are the spec's baseline**: every number in §2 becomes an assertion or
  an explicitly-documented non-goal in the tickets' acceptance criteria.
- `cli-sh.ts` bundle-mode anchor: unit test with a bundled probe (build in-test with
  `bun build --target=bun`, boot, `--ext-list` against a fixture ext tree) — this is a
  cheaper cousin of Gate 3 that runs in `bun test`.
- Doctor: unit test that classifyMode handles the third bucket; e2e assertion via the
  live deploy's `doctor --json`.
- Deploy pipeline: existing gate suite (ext-build tests, offline-gate tests, relocation
  smoke) runs unchanged; `verify-deploy-e2e` on the real outRoot is ticket 03's done-gate.
