# Report — fold tool-gating-contract into core-interface

**Status:** DONE_WITH_CONCERNS
**Impl commit:** see `git log` (committed after this report).
**Base:** f87ae33d (origin/main); branch `refactor/merge-tool-gating-contract-into-core-interface`.

## Outcome
The ambient tool-gating module augmentation was folded out of the standalone
`@repo/pi-tool-gating-contract` package into the contracts home
`@repo/pi-agent-ext-core-interface`, preserving the `/// <reference types="..."/>`
ambient consumption mechanism. The standalone package is deleted. No runtime
code changed anywhere.

## Packaging approach used (empirically validated)
`pi-agent-ext-core-interface` is a source-as-package (no build step). The
previous `exports` was `{ ".": "./src/index.ts" }`. New structure:

```jsonc
// package.json
"exports": { ".": { "types": "./src/types.d.ts", "default": "./src/index.ts" } }
```

with two new files under `src/`:

- `src/tool-gating.d.ts` — **verbatim** copy of the former standalone package's
  sole file (the `declare module "@earendil-works/pi-coding-agent"` augmentation
  adding `ToolDefinition.gating?`, the global `Gating` interface, and
  `ExtensionAPI.getAllToolDefinitions?()`).
- `src/types.d.ts` — the wiring shim that is the `exports` `types` condition:
  ```ts
  export * from "./index.js";              // runtime symbol types (SEAM_KEYS, publishSeam/readSeam, KnowledgePipeline, ...)
  /// <reference path="./tool-gating.d.ts" />
  ```
- `src/index.ts` gained a load-bearing first line:
  ```ts
  /// <reference path="./tool-gating.d.ts" />
  ```

**Why this exact shape (all validated empirically):**

1. `/// <reference types="@repo/pi-agent-ext-core-interface" />` resolves the
   package's `exports` `types` condition → `src/types.d.ts`. A `reference types`
   directive requires a `.d.ts` entry; a `.ts` entry is found but its module
   augmentation is NOT applied (consumers then fail TS2339 "Property 'gating'
   does not exist on type 'ToolDefinition'").
2. `import {...} from "@repo/pi-agent-ext-core-interface"` ALSO resolves the
   `types` condition first under node16/NodeNext/bundler resolution. So the
   types entry must carry the runtime symbol types too — `export * from "./index.js"`
   re-exports them — or runtime-symbol imports break with TS2305.
3. **The `/// <reference path="./tool-gating.d.ts" />` line in `src/index.ts` is
   load-bearing, not redundant.** Removing it (while keeping the identical line
   in `types.d.ts`) makes every consumer fail: power-tool TS2339, core-task
   TS2353, tool-gate TS2304 (`Cannot find name 'Gating'`). Reason: consumers
   pull `index.ts` into their program via `types.d.ts`'s `export * from "./index.js"`
   (a real module re-export). A reference path inside a `.ts` module that is in
   the program is processed and pulls the augmentation in; a reference path
   inside a `.d.ts` that was itself loaded only ambiently (via `reference types`)
   is not processed transitively the same way. Keeping the line on `index.ts`
   is what actually applies the augmentation to consumer programs.

The ambient mechanism is fully preserved: consumers get `gating`/`Gating` via
`/// <reference types="@repo/pi-agent-ext-core-interface" />` — **no new runtime
import at any use site.**

## Consumers rewired
All three packages' `/// <reference types="@repo/pi-tool-gating-contract" />`
changed to `/// <reference types="@repo/pi-agent-ext-core-interface" />`:

- `pi-agent-ext-tool-gate/extensions/tool-gate.ts` — **yes** (real consumer).
- `pi-agent-ext-power-tool/src/index.ts` — **yes** (real consumer; 6 `gating:` sites).
- `pi-agent-ext-core-task/extensions/core-task.ts` — **yes (REWIRE, not remove)**.

### ⚠ Correction to the brief/spec: core-task is NOT a dead reference
The brief/spec stated core-task's triple-slash was a "DEAD ref — no gating
usage" and step 5 said to remove it. The mandatory grep-verify gate
**contradicted** that premise: core-task actively uses `gating: { core: true }`
on three `ToolDefinition`-typed tool literals —
`src/goal/goal.ts:184` (`goal_complete`), `src/todo/todo.ts:37` (`todo`),
`src/ask-user/ask-user-question.ts:74` (`ask_user_question`) — and ships a
dedicated `src/__tests__/core-gating.test.ts` asserting each carries
`gating.core === true`. Removing the triple-slash (while deleting the standalone
package) would break core-task's typecheck (TS2353 on all three sites). The
correct action — rewire to `core-interface`, exactly like tool-gate/power-tool —
was taken. core-task's own `package.json` devDep was likewise swapped
`@repo/pi-tool-gating-contract` → `@repo/pi-agent-ext-core-interface`.

Each consumer's `package.json` devDep was swapped `@repo/pi-tool-gating-contract`
→ `@repo/pi-agent-ext-core-interface` (tool-gate, power-tool, core-task) so the
`reference types` resolves from the consumer's own `node_modules` and the
workspace graph no longer references the deleted package. This package.json
wiring is an unavoidable consequence of deleting the referenced package (the
brief's commitScope listed only the `.ts` files for the three consumers, but
`bun install` cannot resolve a deleted workspace package — the devDep swaps are
mandatory).

## pi-tool-gating-contract deleted
**yes.** Entire `bun-apps/pi-tool-gating-contract/` directory removed
(`package.json`, `tool-gating.d.ts`, `tsconfig.json`). `bun-apps/bun.lock`
regenerated via `bun install` from `bun-apps/`; it no longer references
`pi-tool-gating-contract` (`grep -c pi-tool-gating-contract bun-apps/bun.lock` = 0).

## Verification (all GREEN)
| package | typecheck | test |
|---|---|---|
| pi-agent-ext-core-interface | `check` (tsc --noEmit) PASS | 5 pass / 0 fail (2 files) |
| pi-agent-ext-power-tool | `typecheck` PASS (exit 0) | 146 pass / 4 skip / 0 fail (14 files) |
| pi-agent-ext-core-task | `typecheck` PASS (exit 0) | 742 pass / 0 fail (52 files) |
| pi-agent-ext-tool-gate | (see note) | 296 pass / 0 fail (12 files) |

The gating augmentation resolving correctly is proven by power-tool (6 `gating:`
source sites) + core-task (3 `gating:{core:true}` sites + core-gating test) +
tool-gate (`buildEffectiveGates`'s `gating?: Gating` params) all typechecking
green against `/// <reference types="@repo/pi-agent-ext-core-interface" />`.

**tool-gate typecheck note:** `pi-agent-ext-tool-gate` has **no `typecheck`
script** (only `test` + `qa:*`). Running bare `bunx tsc --noEmit` in the package
surfaces 549 errors, but these are **all pre-existing cross-package errors** from
transitive devDeps (`.ts`-extension imports / node16 explicit-extension errors
in web-access/workflow/zai-mcp/file2md/core-task, and a pre-existing zai-mcp
`Gating` readonly-tuple-vs-mutable mismatch). Proof of pre-existing: with my
changes stashed and `pi-tool-gating-contract` restored (BASE state), the **same
bare-tsc invocation yields exactly 549 errors** — including the identical zai-mcp
`Gating` error (the augmentation content is byte-identical regardless of source
package). My change is **error-neutral (549 = 549)** and `extensions/tool-gate.ts`
itself is clean (no gating/Gating errors → augmentation applied). tool-gate's
actual gate is `bun test` (green). A throwaway probe dir (`bun-apps/_tg_probe/`,
scratch from an earlier attempt) was removed and is not committed.

## Concerns
1. **core-task rewired, not "removed".** The brief/spec mislabeled core-task as a
   dead gating reference; grep proved it is a live consumer (3 tool sites + a
   gating test). Rewired to core-interface instead of removing. This is a
   deliberate, evidence-backed deviation from step 5's literal "remove" — without
   it, core-task's typecheck breaks.
2. **tool-gate has no `typecheck` script.** The verify block's
   `bun run --cwd ... typecheck` is not runnable for tool-gate (or core-interface,
   which uses `check`). Equivalent `tsc --noEmit` / `check` was run instead;
   tool-gate's real gate (`bun test`) is green and its own entry file is clean.
   Pre-existing condition, not introduced here.
3. **Verbatim copy retains a historical package name in a comment.** Per the
   brief's "VERBATIM" instruction, `src/tool-gating.d.ts` is a byte-identical
   copy, so its header doc-comment still references the old
   `/// <reference types="@repo/pi-tool-gating-contract" />` in prose. This is
   documentation only (not a live reference); left verbatim as instructed.
4. **Consumer `package.json` devDep swaps** (tool-gate, power-tool, core-task)
   are slightly beyond the brief's literal `.ts`-only commitScope for those three
   packages, but are mandatory for the workspace to install after the standalone
   package is deleted (no dangling `@repo/pi-tool-gating-contract` references).

No runtime code changed. Diff = types + package.json + deletions + triple-slash
line changes + `bun.lock` regen.
