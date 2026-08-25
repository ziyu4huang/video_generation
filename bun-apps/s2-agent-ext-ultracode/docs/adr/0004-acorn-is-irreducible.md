**ID:** `ADR-ultracode-0004` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# acorn is an irreducible runtime dependency (not replaceable by Bun/node:vm)

**Status:** accepted (locked 2026-07-26)

`acorn` (`^8.16.0`, declared in `dependencies`) parses every workflow script. A natural question on a Bun-native stack is whether the built-in `Bun.Transpiler`, `Bun.build`, or `node:vm` (already used to *execute* scripts) can replace it so workflow reaches zero external runtime deps — symmetric with the base-layer `s2-agent-ext-subagent`. **They cannot.** acorn stays.

## What acorn is actually used for

`parseWorkflowScript()` (`src/workflow.ts`) does two things, both driven by the ESTree AST `parse()` returns:

1. **Extracts `export const meta = { name, description, phases }` as a static literal** — `evaluateLiteral()` walks the AST by hand and accepts *only* `ObjectExpression` / `ArrayExpression` / `TemplateLiteral` / `Literal` / negative-`Literal` `UnaryExpression`. Spread, computed keys, identifiers, and any other expression form are **rejected at parse time**.
2. **Source-slices `export default <fn>`** — uses `node.start` / `node.end` to cut the entry point's source out of the original script, then reconstructs the body (meta + default export removed) for the `vm` to run.

## Why each Bun-native alternative fails

| Alternative | Why it cannot replace acorn |
|---|---|
| **`Bun.Transpiler`** | Exposes only `scan` / `scanImports` / `transform`. **Does not expose an AST.** It can strip `export` syntax and emit JS, but yields no node tree to walk — `evaluateLiteral`'s literal whitelist has nothing to operate on. |
| **`Bun.build`** | A bundler; returns transformed output, not a parse tree. Same gap. |
| **`node:vm` (execute, then read `meta`)** | workflow *already* uses `vm` to **run** the body (lines ~972-1010). But executing to obtain `meta` **destroys the static-literal guarantee**: in a vm, `meta` could be `eval(...)`, `globalThis.__x`, or an `evil()` call — the whitelist becomes unenforceable except by post-hoc runtime interception. Worse, **vm execution gives no source spans**, so `export default` source-slicing (item 2 above) has nothing to anchor on and would regress to fragile regex. |

## The two hard blockers

1. **Source slicing needs `node.start` / `node.end`.** The `export default` extraction and body reconstruction are span-based. Neither `vm` nor any Bun built-in returns source spans; only a real parser does. Removing acorn here means falling back to regex, which is brittle across formatting/whitespace/async forms.
2. **`evaluateLiteral` is a security boundary, not just a convenience.** The whitelist guarantees `meta` is a *static, side-effect-free literal* — it cannot reference variables, call functions, or execute anything. That guarantee holds **at parse time, before any code runs**. Switching to vm turns a static invariant into a runtime check and weakens the determinism contract the rest of the engine (the `DETERMINISM_BLOCKLIST`, `validateMeta`) builds on.

## Consequences

- **`dependencies` is `{ "acorn": "^8.16.0" }`, not `{}`.** workflow is the one package in this stack with a genuine external runtime dep; that is by design, not oversight. The base-layer symmetry (`subagent` has zero external deps; workflow has one) reflects a real capability gap, not an inconsistency to fix.
- **`dependencies` vs `peerDependencies` is correct as-is.** acorn is a functional dependency (the engine's parser), not a platform capability provided by the environment — so it is not a peer like `pi-coding-agent` / `pi-tui` / `typebox` / `s2-agent-ext-subagent`.
- **Renaming risk.** `evaluateLiteral`, `parseWorkflowScript`, and the `AnyNode` shape (`Node & { start; end }`) are coupled to acorn's ESTree output. Any future "swap the parser" attempt must preserve both the literal whitelist *and* span availability — which constrains the choice to "another ESTree-span-emitting parser" (e.g. meriyah, espree), not to a Bun built-in.
- **Do not re-litigate.** Revisit only if Bun ships a span-emitting AST parser in core, *or* if workflow drops the static-literal meta contract (a design change, not a dep cleanup).
