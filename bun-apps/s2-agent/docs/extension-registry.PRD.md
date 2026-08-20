# Extension Registry — PRD

> Product requirements + design study for how pi extensions are registered,
> resolved, and loaded in this repo. Written 2026-07-04 after the
> `pi-krea2`/`pi-flux2` load-failure investigation; supersedes the
> `JITI_ESM_EVAL_TEMP_FILE` "fix" (commit 2bbbce9e), which was wrong.

## 1. The problem this solves

`./s2-agent.sh -p "…"` failed in source/dev mode with one of:

```
ResolveMessage: NameTooLong while resolving 'data:text/javascript;base64,…'
ResolveMessage: Cannot find module '/private/var/…/jiti-esm/binary-*.mjs' from ''
```

Any extension whose import graph contained a module over ~4 KB
(`s2-agent-ext-flux2/src/binary.ts`, krea2's, `pi-hermes-memory`'s 40 KB+
modules) was un-loadable. The whole manifest failed fast on the first one.

## 2. Root cause (the chain, in order)

1. **Manifest auto-loads every extension.** `run-dir/manifest.json` is the
   single source of truth (`run-dir/resolve.ts` splices each path into
   `process.argv` via the `load-run-dir-resources` patch). `.pi/settings.json`
   is INERT in this repo.

2. **pi loads each `-e` extension via jiti.** `@earendil-works/pi-coding-agent/
   dist/core/extensions/loader.js` calls
   `createJiti(import.meta.url, { moduleCache:false, alias: getAliases() })`
   then `jiti.import(extensionPath, { default: true })`.

3. **jiti's `try-native` fails first.** In source mode `tryNative` defaults on,
   so jiti asks Bun to import the `.ts` directly. Bun walks node_modules from
   the **importing file's location** (`bun-apps/s2-agent-ext-*/extensions/`).
   The extension's bare specifiers — `@earendil-works/pi-coding-agent`,
   `typebox`, `@earendil-works/pi-agent-core` — are declared as
   **peerDependencies**, which Bun's isolated linker does NOT place on the
   walk-up path. Native resolution fails → jiti falls back to transforming.

4. **Transform + Bun breaks at >4 KB.** jiti transforms every module in the
   graph to apply its alias rewrite, then evaluates each. Under Bun + jiti
   2.7.0 a transformed module over ~4 KB fails two ways:
   - default path: base64 `data:text/javascript` URL → `NameTooLong`;
   - `JITI_ESM_EVAL_TEMP_FILE=true` path: writes `…/jiti-esm/<basename>-*.mjs`
     then fails to import it (`from ''` — empty referrer).

   **Both transform paths are dead under Bun.** Only modules <~4 KB survive
   the data-URL path, which is why `binary.ts` (7 KB, no bare imports of its
   own) tripped first — it is large *and* in a graph that triggered transform.

### Why the earlier fix was wrong

`JITI_ESM_EVAL_TEMP_FILE=true` (commit 2bbbce9e) traded `NameTooLong` for the
temp-file error. Its regression test (`PROBE_TS_LARGE`) was a single >4 KB
file with **no imports** — that loads via `try-native` regardless (Bun imports
`.ts` natively, no transform), so it never reproduced the real failure mode: a
multi-module graph with bare specs **and** a >4 KB module. "Verified: flux2 +
full manifest load" did not survive re-test at the same commit. The env was
removed from `cli.ts`.

## 3. The correct design (and the fix)

The package design is already correct: extensions declare the host packages
as **peerDependencies** (the host provides them). The bug is purely that those
peers were not physically resolvable from the extension's file location at
load time. Make them resolvable and `try-native` succeeds → Bun imports the
`.ts` graph natively (Bun handles `.ts`; there is **no module-size limit**)
→ jiti never transforms → the bug never fires.

### Fix: `ensure-extension-deps` patch

`src/patches/ensure-extension-deps.ts` (env `BUN_PI_ENSURE_EXT_DEPS`, default
on, **source mode only**):

- Resolves the four packages `getAliases()` resolves —
  `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `typebox` —
  via `createRequire(pcaPkg)` from pi-coding-agent's own `package.json`. This
  is byte-for-byte the same resolution the host uses, so every extension
  shares ONE typebox / pi-coding-agent instance (no version drift, no
  duplicated `@babel/*` from typebox).
- Creates idempotent repo-root `node_modules/<spec>` symlinks → those
  packages. Repo root is on the node_modules walk-up path from every
  `bun-apps/*` member.
- Relinks only when the target moved (e.g. after a `bun install` re-pin);
  otherwise no-op. Regenerated each run.

Bundle mode symlinks its own `node_modules` at build time; the compiled
binary cannot load `.ts` extensions at all (see `s2-agent-three-launch-modes`
memory). Both skip this patch (gated on `import.meta.url` containing
`/src/patches/`).

## 4. Registry model (how to author / register an extension)

```
run-dir/manifest.json          # SOURCE OF TRUTH — the registry
  extensions[]                 # always-loaded (9 today — incl. all MLX exts: flux2, krea2, ltx)
  lazyExtensions{}             # on-demand (workflow, dynamic-workflows)
  npmExtensions[]              # npm-sourced ({ pkg, entry })
  skills[]                     # skill dirs
```

**To add an extension:**

1. Create `bun-apps/s2-agent-ext-<name>/` (workspace member).
2. `extensions/<name>.ts` — `export default (pi) => { pi.registerTool({ name, … }); }`.
3. Declare host deps as peers (so the design stays host-provided):
   ```json
   "peerDependencies": {
     "@earendil-works/pi-coding-agent": "*",
     "typebox": "*"
   }
   ```
4. Add `"bun-apps/s2-agent-ext-<name>/extensions/<name>.ts"` to
   `run-dir/manifest.json` `extensions[]` (or `lazyExtensions` if on-demand).
5. `bun test bun-apps/s2-agent/src/__tests__/extension-contract.test.ts` — must load + wire (see §5).

If an extension imports a **new** bare specifier not in the patch's `targets`,
add it there too (mirroring `getAliases`). Don't reach for jiti env knobs.

**Constraints (don't fight these):**
- `.ts` extensions load in source + bundle modes only, NOT the compiled binary.
- `pi-coding-agent`/`typebox` must resolve to the host's copy (peer model) —
  never bundle a separate typebox per extension (each pulls ~6.5 MB of
  `@babel/*`; see `pi-extension-thin-bundle-jiti-nametoolong`).
- A bundle-mode extension artifact must pre-resolve bare specs to absolute
  paths at build time (same reason: avoid jiti's transform path).

## 5. Verification

- **Fast / authoritative:**
  `bun test bun-apps/s2-agent/src/__tests__/extension-contract.test.ts`
  (replaced the old standalone `scripts/verify-extensions.ts` script) —
  native-imports every factory in the manifest (+ lazy exts) with a mock `pi`,
  asserts each loads without error, wires ≥1 tool/command, has zero tool-name
  conflicts, and every tool/command is fully shaped.
  No agent boot, no providers, no network — milliseconds. Run after any
  manifest or extension change.
- **End-to-end:** `./s2-agent.sh -e <ext.ts> -p "…"` (slow; real session).
- **Patch ran?** `BUN_PI_DEBUG_PATCHES=1 ./s2-agent.sh …` → look for
  `✓ ensure-extension-deps`.
- **Unit:** `bun test` in `bun-apps/s2-agent` (the patch table's
  exhaustiveness guard catches a missing `case`).

## 6. Open notes

- `zai-mcp` registers tools dynamically inside `session_start` (MCP servers
  load async), so it shows 0 static tools — expected, not a failure.
- `pi-obsidian` imports `js-yaml` (not in `getAliases`); it resolves today via
  the workspace. If it ever stops resolving, add `js-yaml` to the patch's
  `targets` rather than declaring it ad hoc.
