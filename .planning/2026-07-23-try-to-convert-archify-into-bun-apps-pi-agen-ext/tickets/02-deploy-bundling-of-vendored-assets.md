## Question

Does the pi-agent deploy pipeline (bundle/THIN, `--release`, `--portable`) capture **vendored `.mjs` + `.json` schema files** inside a `pi-agent-ext-*` package, and what `files` / `exports` / include-rules must `pi-agent-ext-archify` declare so they survive all three deploy modes?

If the bundler only follows `.ts` imports, a vendor-copy of `.mjs` could silently vanish from a deployed artifact — a failure that only shows up at `doctor --smoke` time.

**type:** research
**blocked by:** —

## Resolution (research pass, 2026-07-23) — CLOSED

**VERDICT: VENDORED `.mjs` + `.json` DEPLOY CLEAN in all current deploy modes — with one config rule.**

Current modes (**corrects** the older 'bundle / --release / --portable FULL-bundle' model — FULL bundles were removed by the 2026-07-18 unified-deploy plan; read from live `build-extensions.ts`, not stale memory):
- **THIN bundle** — `Bun.build` follows ESM `import`s transitively → imported `.mjs` inlined, imported JSON inlined.
- **`--snapshot`** — `cpSync` recursive copies the entire package verbatim → all `.mjs`/`.json` survive; `package.json` `files` is ignored.
- `--portable` is now just a **runtime marker**, not a distinct bundle mode.

**The one rule:** `Bun.build` only follows `import` — a JSON schema loaded via `fs.readFile(path)` at runtime will NOT be bundled into THIN. → **`import` schemas** (`import schema from './x.json'`) rather than path-load them (or rely on `--snapshot`, which copies everything regardless).

**Required `package.json`:** `exports` `{ "./extensions/*", "./lib/*", "./vendored/*" }` + `files` `[extensions, lib, vendored, README.md]` (matches `research-tool` / `flux2`). Keep vendored `.mjs` + `.json` under `vendored/` (or `lib/`). Peer deps (`typebox`, `@earendil-works/*`) stay external via `THIN_EXTERNALS` — fine.
