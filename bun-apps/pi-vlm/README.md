# pi-vlm

VLM document describer for [pi](https://pi.dev): turns PDF pages and images
into Obsidian-flavored Markdown via a local Vision Language Model (LM Studio),
then drops the result into a project-local vault. PDFs are rasterized page by
page, each page is described by the VLM, and the pages are stitched into one
`.md` with frontmatter + per-page sections.

## What you get

- `vlm-describe` — the pi tool/CLI entry point (`<files...>` → Markdown).
- A resumable pipeline (`src/pipeline.ts`) that caches per-page VLM output and
  retries transient (429 / network) errors.
- `DEFAULT_VLM_MODEL` and friends exported for reuse by downstream packages
  (e.g. `bun-pi-agent-cli`'s `pdf-to-vault` stage 1).

## Requires

- **[LM Studio](https://lmstudio.ai)** serving a vision model at
  `http://localhost:1234/v1` (no API key needed; `LM_STUDIO_API_KEY=lm-studio`
  works as a dummy). Configure the model id via `--vlm-model` / `PI_VLM_MODEL`.

## Bundle for distribution (minify + obfuscation)

Ship the extension as a single minified `.js` instead of `.ts` source:

```bash
bun scripts/build-bundle.ts               # minify (identifier mangling)
bun scripts/build-bundle.ts --obfuscate   # + javascript-obfuscator pass (optional)
```

Output: `../../dist/pi-extensions/pi-vlm.bundle.js` (gitignored, like `dist/pi-agent/`).
typebox + `src/pipeline.ts` + transitive deps are inlined into one ESM file with
the default factory export preserved, so pi's jiti loader imports it unchanged.

`--minify` already renames local identifiers (`var A56=Object.create;…`), which
defeats casual reading. `--obfuscate` adds string-array + encoding transforms via
[`javascript-obfuscator`](https://github.com/nicedoc/javascript-obfuscator); it is
optional (not a default dep) and slow on multi-MB bundles — install with
`bun add -d javascript-obfuscator` if you want it, otherwise the flag no-ops with
a warning.

Load the bundle with the pi-agent bundle:

```bash
bun ../../dist/pi-agent/pi-agent.js -ne \
  -e ../../dist/pi-extensions/pi-vlm.bundle.js -p "list your tools"
```

## Known limitations & TODO

- **`src/sessions.ts` forks `bun-pi-agent-cli`'s `sessions/shared.ts`.**
  `resolveLLM`, `resolveModel`, and the session-construction wiring are
  near-duplicates of the CLI's shared helpers — they have already drifted
  (this copy lacks the CLI's `PI_PROVIDER` read and case-insensitive provider
  match). Packages can't import the downstream CLI, so the right fix is to
  extract the model-resolution + session-factory primitives into a neutral
  shared module both consume, then delete the fork. Until then, any fix to the
  model-id grammar must be applied in two places.

## License

MIT
