# pi-file2md

A file→Markdown bridge for [pi](https://pi.dev): convert any PDF or image into
structured Markdown that a **pure-text agent can read**, using a local
vision-LLM subagent (LM Studio). PDFs are rasterized page by page, each page
is described by the vision-LLM subagent, and the pages are stitched into one
`.md` with frontmatter + per-page sections, then dropped into a project-local
vault. The point: give a text-only agent eyes — it never has to "see" the file.

## What you get

- `file2md` — the pi tool/CLI entry point (`<files...>` → Markdown).
- A resumable pipeline (`src/pipeline.ts`) that caches per-page VLM output and
  retries transient (429 / network) errors.
- `DEFAULT_VLM_MODEL` and friends exported for reuse by downstream packages
  (e.g. `pi-agent cli`'s `pdf-to-vault` stage 1).

## Internal docs

[`docs/`](./docs) traces how `vision_ask` / `file2md` actually run, with
source citations into the installed `pi-coding-agent` + `pi-ai`:

- [docs/architecture.md](./docs/architecture.md) — end-to-end call chain,
  sequence diagram, model resolution (`resolveLLM`), and how an image part is
  serialized to the provider wire format by the pi-ai adapter.
- [docs/configuring-vision-models.md](./docs/configuring-vision-models.md) —
  registering vision models in `~/.pi/agent/models.json`, switching backends
  at runtime, and the per-`api` image wire-format comparison.

## Requires

- **[LM Studio](https://lmstudio.ai)** serving a vision model at
  `http://localhost:1234/v1` (no API key needed; `LM_STUDIO_API_KEY=lm-studio`
  works as a dummy). Configure the model id via `--vlm-model` / `PI_VLM_MODEL`.

## Bundle for distribution (minify + obfuscation)

Ship the extension as a single minified `.js` instead of `.ts` source:

```bash
bun scripts/build-bundle.ts               # FULL bundle (default) — inline all deps
bun scripts/build-bundle.ts --obfuscate   # + javascript-obfuscator pass (optional)
bun scripts/build-bundle.ts --thin        # THIN bundle — peer deps external (see below)
bun scripts/build-bundle.ts --no-verify   # skip the self-verify stage
```

Output: `../../dist/pi-extensions/pi-file2md.bundle.js` (gitignored, like `dist/pi-agent/`).
typebox + `src/pipeline.ts` + transitive deps are inlined into one ESM file with
the default factory export preserved, so pi's jiti loader imports it unchanged.

`--minify` already renames local identifiers (`var A56=Object.create;…`), which
defeats casual reading. `--obfuscate` adds string-array + encoding transforms via
[`javascript-obfuscator`](https://github.com/nicedoc/javascript-obfuscator); it is
optional (not a default dep) and slow on multi-MB bundles — install with
`bun add -d javascript-obfuscator` if you want it, otherwise the flag no-ops with
a warning.

### Self-verify (built-in)

Every build ends with `stageVerify`: static integrity checks (default factory
export present, minify applied, no dangling `../src/` refs or `/Users/` path
leak, size sane, externals preserved in thin / inlined in full) **and**, when
`dist/pi-agent/pi-agent.js` exists, a **live load test** that boots the real
pi-agent bundle with `-ne -e <bundle>` and asserts `file2md` registers. A
load crash at the shipping path is a **hard failure** (exit 1) — it cannot ship a
bundle that doesn't load. `--no-verify` skips.

### FULL vs THIN — which to use

Both produce a loadable `pi -e <bundle>.js`. **THIN is the better default** for
this repo; FULL is the fallback when you need a self-contained, machine-portable
artifact.

**FULL** (`bun scripts/build-bundle.ts`) inlines typebox + `src/` + every
transitive dep (notably typebox's ~6.5 MB `@babel/*` compiler) into one ~6.8 MB
ESM. Self-contained, portable. Cost: **multi-extension duplication** — each full
extension carries its own typebox+babel, AND the pi-agent host carries another, so
N full extensions = (N+1)× the ~6.5 MB babel graph loaded.

**THIN** (`--thin`) bundles only the project's own `src/` (~25 KB, 270× smaller)
then rewrites the 4 peer-dep bare specifiers (`typebox` + `@earendil-works/*`)
to **absolute file paths**. That rewrite is mandatory — see the gotcha below.
Benefit: every extension resolves `typebox` to the SAME path → bun's native
module cache dedupes → **all extensions share one typebox instance** (no per-copy
babel). Typebox version can never drift from the host (it IS the host's copy).
Cost: the baked paths are **machine-specific** — rebuild on the target machine
(mirrors the pi-agent bundle's own machine-path baking).

#### Gotcha: why THIN must rewrite bare specifiers to absolute paths

pi loads every extension through jiti (`createJiti` + `jiti.import`,
`pi-coding-agent/dist/core/extensions/loader.js`). jiti wraps any module that
contains a **bare specifier** (e.g. `"typebox"`) in a
`data:text/javascript;base64,<whole module>` package specifier to apply its
alias transform — and bun rejects that wrapper with `NameTooLong` once the module
exceeds a low-KB limit. Every real pi-file2md module is over that limit, so a thin
bundle that leaves `"typebox"`/`"@earendil-works/*"` as bare specifiers is
**unconditionally broken** at the shipping location:

```
Failed to load extension: ResolveMessage: NameTooLong while resolving
package 'data:text/javascript;base64,...'
```

FULL dodges it by having zero bare imports. The thin fix: `stageResolveExternals`
pre-resolves each bare specifier to its absolute file path at build time (the
same paths `getAliases()` computes at runtime) — the bundle then has only
absolute + `node:` + relative imports, so jiti loads it **natively** (no wrapper,
no size limit). Verified end-to-end. The `stageVerify` live-load test enforces
this: a load crash at the shipping path is a hard failure (exit 1), so a
regression (e.g. a new bare import that escapes resolution) can't ship silently.

> Lesson logged in memory (`pi-extension-thin-bundle-jiti-nametoolong`) and
> here so the same detour isn't repeated: **jiti + bare-import module = data-URL
> wrap = length-limited. Either inline the dep (FULL) or pre-resolve to abs path
> (THIN). There is no third option under the current loader.**

Load the bundle with the pi-agent bundle:

```bash
bun ../../dist/pi-agent/pi-agent.js -ne \
  -e ../../dist/pi-extensions/pi-file2md.bundle.js -p "list your tools"
```


## Known limitations & TODO

- **`src/sessions.ts` forks `pi-agent`'s `src/cli/sessions/shared.ts`.**
  `resolveLLM`, `resolveModel`, and the session-construction wiring are
  near-duplicates of the CLI's shared helpers. `resolveLLM` reads the same env
  knobs as the CLI (`PI_MODEL`, `PI_PROVIDER`, `PI_THINKING`) and `resolveModel`
  does a case-insensitive provider+id match, so the earlier documented drift is
  closed (grammar is pinned by `__tests__/sessions.test.ts`). Packages can't
  import the downstream CLI, so the durable fix is still to extract the
  model-resolution + session-factory primitives into a neutral shared module
  both consume, then delete the fork. Until then, any fix to the model-id
  grammar must be applied in two places.

## Tests

```bash
bun test        # from this package dir
```

The suite covers the **pure, deterministic core** — no LM Studio, network, or
real model session is needed: `resolveLLM` model-id grammar + env fallbacks
(`__tests__/sessions.test.ts`, pins the `PI_PROVIDER` resolution parity with
the CLI), the retry predicate/loop (`retry.ts`), manifest layout math
(`slugify` / `pageLabel` / `layoutFor` / `createManifest`), and the kind/mime
classifiers (`classifyKind` / `imageMimeType`, including magic-byte fixtures).
The I/O- and model-bound `pipeline.ts` / `agents.ts` / `classify-vlm.ts` /
`pdf2png.ts` are out of scope.

## License

MIT
