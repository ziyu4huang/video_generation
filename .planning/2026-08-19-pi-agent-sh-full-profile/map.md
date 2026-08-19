effort: 2026-08-19-pi-agent-sh-full-profile
created: 2026-08-19
last: 2026-08-20
status: complete
---

# Wayfinder map: 2026-08-19-pi-agent-sh-full-profile

Grow the pi-agent-sh base extension set from the 3-extension MVP
(task / power-tool / hyperframes) to the "portable full-featured agent"
profile the user pinned: memory, skills, subagent/workflow, and web-access
in the box. Deliverable = empirical candidate evaluation + the config/pipeline
changes + a deployed new version.

## Destination

`deploy-config.yaml` ships 12 extensions; every candidate's bundling class is
MEASURED by a scratch-config trial deploy (the four gates as judge), not
guessed; the pipeline gains the two mechanisms the larger set needs
(`copy:` data dirs, the `#pi/ext-dir` runtime channel); docs record the
inclusion/exclusion rationale. See `candidate-evaluation.md` for the full
matrix.

## Decisions

- **Base set (12)**: task, prompt-history, superpowers, wayfind,
  hermes-memory, subagent, workflow, btw, web-access, power-tool, webui,
  hyperframes. subagent (60) loads before workflow (70) — registry
  population order.
- **Three new host modules**: `@earendil-works/pi-ai` (+`/compat`) — already
  compiled in via pi-coding-agent, zero core cost; `@repo/pi-agent-ext-subagent`
  — the package is both an extension and a shared library whose in-flight
  registry is an identity-sensitive singleton. HOST_API stays 1 (additive).
- **`copy:` config field**: same verbatim dir copy as `skills:`, but NOT
  forwarded to pi as `--skill` (wayfind `procedures/`, hermes `scripts/`).
- **`#pi/ext-dir` runtime channel** (the deep one): bun's cjs output folds
  `import.meta.url` into a build-machine path literal, REBINDS
  `__dirname`/`__filename` identically, and unfolded `import.meta` is a
  SyntaxError in the loader's indirect cjs eval. Extensions therefore locate
  their deployed data via `require("#pi/ext-dir")`, served by
  `evaluateExtModule`; in jiti/source the same spec resolves via each
  package's `package.json` `"imports"` entry to `src/sh-ext-dir.ts`
  (jiti compiles cjs → real `__dirname`). Verified jiti 2.7.0 honors the
  imports field.
- **Vendored resolution by absolute file**: measured that inside a compiled
  binary `createRequire(<real path>)` / `Bun.resolveSync` cannot resolve
  PACKAGES from the real fs (virtualized onto $bunfs) — the loader fallback
  now reads the vendored package.json and requires the entry file directly.
  Means the pre-existing power-tool vendoring path was never actually
  exercised by any gate until web-access required unpdf at module top level.
- **unpdf vendored** (web-access): its ESM uses `import.meta.resolve`, whose
  syntax cannot live in a cjs bundle at all.
- **Exclusions**: obsidian (cross-ext registry + pi-agent-core), knowledge-card
  (imports obsidian's entry — cascade), file2md (mupdf + LM Studio localhost),
  the director/MCP wrappers (machine-bound swift CLIs), devops/tool-gate
  (repo-internal). All remain available in legacy source/run-dir modes.
