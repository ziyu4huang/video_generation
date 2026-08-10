# Task 0 Report — Scaffold `pi-agent-ext-webui`

**Ticket:** 03 (agentic mutex) — Task 0
**Branch:** `03-agentic-mutex-impl`
**Status:** DONE_WITH_CONCERNS (one intentional scope decision on `bun.lock`, documented below)

## What was implemented

Created the `bun-apps/pi-agent-ext-webui/` package from scratch — an empty, buildable, testable scaffold that will host the agentic-mutex module. Task 0 produces only the shell; the mutex code (Task 1) and the Bun.serve pi extension (tickets 02/04) land later.

Four files created with the brief's verbatim content:

- `bun-apps/pi-agent-ext-webui/package.json` — `@repo/pi-agent-ext-webui`, private, `type: module`, scripts `build`/`test:unit`/`test`, devDeps `@types/bun@^1.3.14` + `typescript@^7.0.2`.
- `bun-apps/pi-agent-ext-webui/tsconfig.json` — ES2022 target, NodeNext module/resolution, strict, `rootDir: src`, `outDir: dist`, `declaration: true`, `types: ["bun"]`, `lib: ["ESNext","DOM"]`.
- `bun-apps/pi-agent-ext-webui/src/index.ts` — placeholder doc-comment + `export {};`.
- `bun-apps/pi-agent-ext-webui/.gitignore` — exactly two lines: `node_modules` then `dist`.

No interfaces, no mutex logic (correct for Task 0).

## TypeScript-version decision

**No change needed.** The brief pins `typescript: "^7.0.2"`. `bun install` resolved it cleanly to **`typescript@7.0.2`** (visible in the regenerated `bun-apps/bun.lock`: `@repo/pi-agent-ext-webui/typescript` → `typescript@7.0.2`). `bun run build` (`bunx tsc`) emitted `dist/` with zero errors, so the fallback to `pi-agent-ext-wayfind`'s version was never triggered. (For the record, the wayfind sibling uses the identical range `^7.0.2`, so a fallback would have been a no-op anyway.)

## Toolchain evidence (actual command output)

### Step 5a — `( cd bun-apps && bun install )`

```
bun install v1.3.14 (0d9b296a)
Resolving dependencies
Resolved, downloaded and extracted [27]
Saved lockfile

Checked 744 installs across 818 packages (no changes) [689.00ms]
```

The new workspace package registered (lockfile gained the `pi-agent-ext-webui` workspace entry — see diff in the Concerns section).

### Step 5b — `( cd bun-apps/pi-agent-ext-webui && bun run build )`

```
$ bunx tsc
```

Exit 0, zero errors. Emitted:

```
dist/index.js   (11 bytes:  export {};
)
dist/index.d.ts (311 bytes — doc comment + `export {};`)
```

### Step 5c — `( cd bun-apps/pi-agent-ext-webui && bun test )`

```
bun test v1.3.14 (0d9b296a)
No tests found!

Tests need ".test", "_test_", ".spec" or "_spec_" in the filename (ex: "MyApp.test.ts")

Command exited with code 1
```

"No tests found" is the expected/accepted result per the brief — Task 1 adds the mutex tests. (Bun exits 1 on no-tests; this is not a failure of the scaffold.)

## Files changed (commit `96b7e5d9`)

```
96b7e5d9 feat(webui): scaffold pi-agent-ext-webui package (ticket 03 host)
 bun-apps/pi-agent-ext-webui/.gitignore    |  2 ++
 bun-apps/pi-agent-ext-webui/package.json  | 23 +++++++++++++++++++++++
 bun-apps/pi-agent-ext-webui/src/index.ts  |  7 +++++++
 bun-apps/pi-agent-ext-webui/tsconfig.json | 17 +++++++++++++++++
 4 files changed, 49 insertions(+)
```

Exactly the 4 paths the brief's Step 6 names. Commit message is the brief's verbatim string.

## Self-review

- ✅ All 4 files created with brief-verbatim content (re-read committed blobs via `git show HEAD:...` to confirm byte-for-byte: package.json, tsconfig.json, src/index.ts, .gitignore all match).
- ✅ `bun install` run from workspace root (`bun-apps/`), never the repo root.
- ✅ No top-level `cd` — all commands used `( cd <dir> && ... )` subshells.
- ✅ Staged explicit paths only; never `git add -A`/`git add .`.
- ✅ Did NOT touch `python/embed-bench/backends/mlx_native.py` (still shows as ` M`, unstaged, untouched) or anything under `.planning/` (still `??`, untouched).
- ✅ `dist/` and `node_modules/` confirmed gitignored (`git check-ignore` returns both).
- ✅ Commit contains only files under `bun-apps/pi-agent-ext-webui/`.
- ✅ `bun run build` green; `bun test` runs (no tests is expected).

## Concerns

### 1. `bun-apps/bun.lock` left uncommitted (intentional, by scope rule)

Registering the workspace package modified `bun-apps/bun.lock`. The diff is entirely the new package's registration — nothing else:

```diff
@@ workspaces block @@
+    "pi-agent-ext-webui": {
+      "name": "@repo/pi-agent-ext-webui",
+      "version": "0.1.0",
+      "devDependencies": {
+        "@types/bun": "^1.3.14",
+        "typescript": "^7.0.2",
+      },
+    },

@@ resolutions @@
+    "@repo/pi-agent-ext-webui": ["@repo/pi-agent-ext-webui@workspace:pi-agent-ext-webui"],

@@ lockfile entries @@
+    "@repo/pi-agent-ext-webui/typescript": ["typescript@7.0.2", ...],
```

I intentionally did **not** commit it, because:

- The task's global constraint states the commit must contain **ONLY** files under `bun-apps/pi-agent-ext-webui/`, and `bun.lock` lives at `bun-apps/bun.lock` (outside that path).
- The brief's Step 6 gives an exact `git add` command listing precisely the 4 package files (omitting `bun.lock`).
- The instruction was to "implement exactly" / "follow the brief's Step 1–6 exactly."

**Follow-up needed:** `bun-apps/bun.lock` should be committed (either in the Task 1 commit, or a separate small `chore: register pi-agent-ext-webui in lockfile` commit) so the repo lockfile stays in sync. Until then, `bun install` will keep reporting a one-time regeneration that is already present locally. This does not affect build or test correctness.

### 2. (Informational, not blocking) `bun test` exits 1 on "no tests"

This is Bun's default behavior with zero matching test files and is explicitly accepted by the brief for Task 0. Task 1 will introduce `*.test.ts` files and turn this green.

## No other deviations

No fallback version was needed; no files were paraphrased; no out-of-scope paths were touched. The scaffold is ready for Task 1 (mutex module + tests).
