# pi-agent-sh base-extension candidate evaluation (2026-08-20)

Method: every candidate went through the REAL trial pipeline
(`deploy:sh --config /tmp/sh-trial-config.yaml --out /tmp/sh-trial-out`) so the
four gates (foreign specifiers / load probe / dual-state smoke / foreign paths)
judged actual bundles, plus a relocated-tree `--ext-list` + `doctor --smoke`
probe. Sizes below are `ext.cjs` bytes from the trial deploy output.

## Results

| Extension | Verdict | ext.cjs | Mechanism / notes |
|---|---|---|---|
| task | in (existing) | 144,376 | plain entry |
| prompt-history | ✅ IN | 1,823 | pure code, no skills |
| superpowers | ✅ IN | 6,013 | `skills:` copy; runtime dir via `#pi/ext-dir` |
| wayfind | ✅ IN | 165,792 | `skills:` + **`copy: [procedures]`**; `#pi/ext-dir` |
| hermes-memory | ✅ IN | 488,619 | `skills:` + `copy: [scripts]` (merge driver); sqlite = `bun:sqlite` builtin |
| subagent | ✅ IN | 86,402 | host-lib consumer (core-runtime, pi-ai, own lib) |
| workflow | ✅ IN | 375,778 | loads after subagent; acorn inlines |
| btw | ✅ IN | 40,076 | plain entry |
| web-access | ✅ IN | 879,311 | **`vendor: ["unpdf"]`** — import.meta.resolve syntax |
| power-tool | in (existing) | 216,805 | vendor playwright-core (unchanged) |
| webui | ✅ IN | 166,682 | pure code — HTML shell is an inline string constant |
| hyperframes | in (existing) | 694 | skills-only carrier (~5.5MB copied) |
| obsidian | ⏸ defer | — | imports subagent registry (identity) + `@earendil-works/pi-agent-core`; revisit |
| knowledge-card | ❌ out | — | imports obsidian's extension entry directly (`src/retrieve.ts:38`) — cascade |
| file2md | ❌ out | — | mupdf native/wasm + hard LM Studio localhost dep — not portable |
| movie-director, flux2, krea2, ltx, zai-mcp, research-tool, archify | ❌ out | — | wrap this machine's swift CLIs / local services |
| devops, tool-gate | ❌ out | — | repo-internal build/test tooling |

Core: 70,529,762 bytes — unchanged by the three new host modules (pi-ai was
already compiled in via pi-coding-agent).

## Defects found and fixed on the way (all by gates/probes, not by review)

1. **`import.meta.url` folding** (gate 4, superpowers): bun's cjs output folds
   it to a build-machine path literal. Deeper: an UNfolded `import.meta` is a
   SyntaxError inside the loader's indirect cjs eval (verified), and
   `__dirname`/`__filename` references make bun REBIND them to build paths.
   Fix: `require("#pi/ext-dir")` channel (loader-served in sh; package.json
   `imports` entry → `src/sh-ext-dir.ts` under jiti).
2. **`constants` builtin missing** from `host-modules.ts` BUILTINS (gate 2,
   web-access graph) — added the legacy aliases (`constants`, `sys`, `domain`).
3. **unpdf `import.meta.resolve`** (gate 2 SyntaxError, web-access): vendored;
   as a real directory it loads as a proper ESM module.
4. **`createRequire(import.meta.url)` in web-access** (gate 4, glimpseui
   optional-dep probe): rewritten to ambient `require.resolve` with an
   execPath-based fallback.
5. **Vendored packages unresolvable inside the compiled binary** (gate 3,
   web-access/unpdf): `createRequire(<real path>)("pkg")` and
   `Bun.resolveSync` both fail on the real fs inside `--compile` (measured);
   the loader fallback now resolves the vendored entry FILE (exports →
   require/default → main) and requires it absolutely. Root-caused from a
   swallowed `ReferenceError` (missing `isBuiltinSpecifier` import) that the
   fallback's catch re-branded as the host's error — the catch-rethrow pattern
   hides its own bugs; worth remembering.

## Verification performed

- Trial deploy: all gates green, `--ext-list` = 12 loaded / 0 skipped.
- Relocated tree (`cp -R` to a new path): 12 loaded / 0 skipped.
- `doctor --smoke --json` on the relocated tree: `mode: sh`, `ok: true`,
  `total=36 matched=29`.
- Unit: superpowers 140✓, wayfind 466✓ (+biome), hermes-memory 1637✓,
  web-access 91✓, pi-agent src/sh 36✓, devops sh-config/sh-ext-build 62✓.
