## Question
Can this repo owner-declare `gating:{ core: true }` on pi-coding-agent's built-in tools `read`, `write`, `edit`, `bash`? They live in `@earendil-works/pi-coding-agent` (upstream — `dist/core/tools/{read,write,edit,bash}.js`), NOT in this repo, so the in-repo tool-def augmentation pattern can't reach them directly. Determine: (a) is pi-coding-agent an editable sibling repo or an immutable npm dependency? (b) does its tool-def type already accept `gating` (is the global `Gating` augmentation in `types/tool-gating.d.ts` visible to pi-coding-agent's tool defs)? (c) what's the viable mechanism to get `core:true` onto the 4 built-ins — a sibling-repo edit, an in-repo registration-time augmentation hook, or a cross-repo PR? This fact gates the destination (full CORE_TOOLS deletion) and the shape of ticket 03.

type: research
blocked by:
claimed: wayfind-01
status: closed  # FORK resolved — Path B chosen (in-repo injection, defer upstream).

## Resolution — ticket 01 (FORK: destination-level decision needed)

**Headline:** This repo can make `read`/`write`/`edit`/`bash` *behave* as core
in-repo (runtime injection via the existing `getAllToolDefinitions` patch), but it
**cannot owner-declare** `gating:{core:true}` on them — only `pi-coding-agent`
(their registering package) can, and that package is an **immutable npm install**
(no editable sibling). True owner-declaration therefore requires a **cross-repo
PR to `@earendil-works/pi-coding-agent`** (heavy, out-of-repo, release-blocking).
The in-repo alternative deletes `CORE_TOOLS` but relocates the 4 built-in names
into a tool-gate injection list — a **residual set in different clothes**, which
**contradicts the destination's "owner-declared end-to-end via upstreaming"
intent** for the built-ins. This is the exact fork the FORK-GUARD anticipated;
left `open` for a destination re-grill or a decision ticket.

### A. Is pi-coding-agent editable or immutable? → **IMMUTABLE npm install.**

- `node_modules/@earendil-works/pi-coding-agent` is a **symlink into the bun
  global cache**: `…/cache/links/@earendil-works+pi-coding-agent@0.83.0+c41fff0105edc355-dbece20a08c20717/node_modules/@earendil-works/pi-coding-agent`.
- Declared as a plain **npm version pin** `"@earendil-works/pi-coding-agent":
  "0.83.0"` in every consuming `package.json` (pi-agent, pi-agent-cli, all
  pi-agent-ext-*). No `file:`/`workspace:`/`link:` override anywhere
  (`grep -rnE '"…pi-coding-agent":\s*"(file:|workspace:|link:)'` → empty).
- `bun-apps/bun.lock:537` resolves it from the **registry** (`[…@0.83.0, "",
  {deps…}, "sha512-…"]` — integrity hash = registry tarball, not a local path).
- **No editable sibling repo.** `ls ~/proj/ | grep -i pi` lists `pi-agent`,
  `pi-agent--*`, `pi-ext-*`, `pi-subagents*`, `pi-web-access`, etc. — **none is
  `pi-coding-agent`**. CLAUDE.md's sibling-fork list is only `../mflux` and
  `../ltx-2-mlx`; `pi-coding-agent` is conspicuously absent.
- `bun-apps/bunfig.toml` explicitly states (isolated linker + globalStore):
  *"edits made directly inside node_modules/<pkg>/ no longer propagate … This
  repo never patches node_modules in place."* JS patches are runtime
  monkey-patches (e.g. `bun-apps/pi-agent/src/patches/`), not in-place edits.

**CONCLUSION A:** immutable install; the built-in tool defs in
`dist/core/tools/{read,write,edit,bash}.js` are **not editable from this repo**.

### B. Does pi-coding-agent's tool-def type accept `gating`? → **NO — `gating` is a tool-gate-extension-only augmentation; the harness never reads it natively.**

- The harness `ToolDefinition` interface lives at
  `…/dist/core/extensions/types.d.ts:343-377`. Its fields are exactly:
  `name, label, description, promptSnippet?, promptGuidelines?, parameters,
  constrainedSampling?, renderShell?, prepareArguments?, executionMode?,
  execute, renderCall?, renderResult?`. **There is no `gating` field.**
- **Whole-word `gating` appears 0 times across the entire `dist/`**
  (`grep -rwn "gating" …/dist/` → 0 hits; the earlier substring hits were all
  `navi`**gating**, a false positive).
- The built-in defs carry no gating: `grep -nE 'gating|core:'
  …/dist/core/tools/{read,write,edit,bash}.{js,d.ts}` → **empty** for all 4.
- `gating` is **added to `ToolDefinition` only by this repo's TS module-augment**
  `bun-apps/pi-agent-ext-tool-gate/types/tool-gating.d.ts`
  (`declare module "@earendil-works/pi-coding-agent" { interface ToolDefinition
  { gating?: Gating } }`). This is a **compile-time declaration-merge** — it
  makes call sites type-check, but the built-in **runtime objects still have no
  `gating` property**. The harness does not consume `def.gating`.
- The only runtime consumer of `gating` is this repo: `buildEffectiveGates()` in
  `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts:100-128` reads
  `def.gating` on each discovered def (`g.core === true` → core set).

**CONCLUSION B:** `gating` is **not native** to pi-coding-agent — neither on the
type nor read at runtime. It is a tool-gate-extension concept layered on top.

### C. Viable mechanism to get `core:true` onto the 4 built-ins? → **two viable paths, a genuine fork.**

**(i) Edit a sibling repo — NOT viable.** No pi-coding-agent sibling exists (A).

**(ii) Cross-repo PR to `@earendil-works/pi-coding-agent` — viable, and is the
ONLY true owner-declaration; but out-of-repo + release-blocking.** Would add
`gating` to the native `ToolDefinition` type AND `gating:{core:true}` to the 4
built-in defs upstream, so `buildEffectiveGates` picks them up via `def.gating`
directly (no fallback). Cost: requires write access to pi-coding-agent, upstream
acceptance (a schema change to a shared type), a **new published release**, and
a **coordinated version bump** `0.83.0 → next` across ~30 `package.json` +
`bun.lock` here. Heavy, external-dependency, release-cadence-bound — it cannot
land as an in-repo ticket in this migration.

**(iii) In-repo runtime injection — viable, fully in-repo, but a RELOCATED
RESIDUAL SET (not owner-declared).** The repo already has the hook:
`bun-apps/pi-agent/src/patches/ext-api-get-all-tool-definitions.ts` monkey-
patches `ExtensionRunner.prototype.bindCore` so the `pi` runtime exposes
`getAllToolDefinitions(): ToolDefinition[]` =
`getAllRegisteredTools().map(t => t.definition)` (runner.d.ts:112) — i.e. **all
registered tools including the 4 built-ins, live `definition` objects**.
tool-gate already calls this in `session_start`/`before_agent_start`
(`getDiscovered()`, tool-gate.ts:401-410) and passes the result to
`buildEffectiveGates(all)`. So tool-gate could inject `gating:{core:true}` onto
the built-in defs (or map them) before that call, deleting `CORE_TOOLS`.
**But** — because the core-4 must be distinguished *by name* (see below), this
is just a hardcoded `BUILTIN_CORE = new Set(["read","write","edit","bash"]])`
moved into tool-gate. tool-gate is **not the owner** of the built-ins
(pi-coding-agent is), so this is **third-party declaration, not
owner-declaration** — a residual set wearing different clothes. It achieves
"`CORE_TOOLS` deleted, behaviorally identical" but **NOT** the destination's
"owner-declared end-to-end via upstreaming."

  *Why the core-4 must be named (no clean source-heuristic):* `dist/core/tools/`
ships **15** files incl. `find`, `grep`, `ls`, `edit-diff` — all pi-coding-agent
built-ins — yet `CORE_TOOLS` contains only `read/write/edit/bash`
(tool-gate.ts:37-58; `grep 'find\"\|grep\"\|ls\"'` → empty). A heuristic
like "all core-source tools → core" would **wrongly** mark `find`/`grep`/`ls` as
always-on core. So (iii) is forced back to a 4-name set = relocated residual.

**CONCLUSION C:** ranked —
1. **(iii) in-repo runtime injection** — lowest effort, in-repo, ships now,
   deletes `CORE_TOOLS`; cost = a small relocated built-in-name set in
   tool-gate (not owner-declared; defers the ideal to a followup).
2. **(ii) cross-repo PR + upstream release + version bump** — the ONLY path that
   achieves true owner-declaration end-to-end (matches the destination as
   written); cost = heavy, out-of-repo, external-release-blocking.
((i) not viable.)

### Recommended mechanism for ticket 03 / what graduates

**No single pick dominates — this is the fork.** The choice re-grills the
*destination*, not just ticket 03's shape:

- **Path A — keep the destination as written (true owner-declared via upstream):**
  ticket 03 becomes a **cross-repo PR to pi-coding-agent** (add `gating` to
  native `ToolDefinition` + `gating:{core:true}` on the 4 built-ins) + a version
  bump here. `CORE_TOOLS`/`fallbackCore` delete cleanly; `buildEffectiveGates`
  sees built-ins via `def.gating`. Heavy, out-of-repo, release-cadence-bound.
- **Path B — revise the destination to accept an in-repo residual for built-ins:**
  ticket 03 adds a `BUILTIN_CORE` (4-name) injection in tool-gate's
  `getDiscovered()`/pre-`buildEffectiveGates` path; deletes `CORE_TOOLS`; leaves
  `fallbackCore` defaulting to empty. True owner-declaration of the built-ins
  **graduates to FOLLOWUPS #5** ("broader upstreaming of `gating` into
  pi-coding-agent") alongside the rest. Ships now, fully in-repo.

**Lean (for the human's decision):** Path B is the pragmatic in-repo realization
— it deletes `CORE_TOOLS` (the migration's mechanical goal) immediately, uses an
**already-built** runtime hook, and is honest about the built-ins' external
ownership by keeping a small, named, well-commented residual whose only purpose
is "the 4 built-ins live in an immutable external package." Path A remains the
ideal but is an external-effort FOLLOWUP. **However**, Path B *does* revise the
recorded destination ("owner-declared end-to-end incl. built-ins via
upstreaming" → "owner-declared for all in-repo tools; built-ins via in-repo
injection, upstreaming deferred") — which is why this is a human decision, not
an implementer call.

**What ticket 03 should do *concretely* once the path is chosen:**
- Path B → in tool-gate.ts, near `getDiscovered()` (~L401), inject
  `gating:{core:true}` onto defs named read/write/edit/bash (or add them to a
  `BUILTIN_CORE` set fed into `buildEffectiveGates`'s `fallbackCore`); then
  delete the `CORE_TOOLS` constant + its `fallbackCore` default; verify the
  `qa`/drift-guard + the schema-cost canary still pass.
- Path A → not an in-repo code ticket; it's a cross-repo PR + version bump.

**Fog that graduates if Path B is chosen:** "the built-in MECHANISM" (map: *Not
yet specified*) resolves to "in-repo runtime injection via the existing
`getAllToolDefinitions` patch"; "whether the built-in rollout is in-repo / PR /
blocked" resolves to "in-repo (injection); upstreaming deferred to FOLLOWUPS #5."
If Path A is chosen, that fog instead resolves to "cross-repo PR + version bump."

### Decision (Path B — chosen by human)
Destination revised: the 4 pi-coding-agent built-ins (read/write/edit/bash) get `gating:{core:true}` via IN-REPO runtime injection (tool-gate injects it through the existing getAllToolDefinitions hook in getDiscovered, ~extensions/tool-gate.ts:401) — pi-coding-agent is immutable + `gating` is extension-only, so true owner-declaration isn't possible in-repo. TRUE owner-declaration (cross-repo PR to pi-coding-agent: add gating to native ToolDefinition + core:true on the 4 + release + version bump) is DEFERRED to FOLLOWUPS #5. Ticket 03 reshapes to "in-repo injection" (was "cross-repo PR"); ticket 04 (delete CORE_TOOLS) unchanged in shape. Fog graduated: the built-in MECHANISM + the rollout-shape questions are resolved (in-repo injection; upstream → FOLLOWUP).

**Evidence files (read-only):**
- `node_modules/@earendil-works/pi-coding-agent` → bun-cache symlink (A).
- `bun-apps/bun.lock:537` (registry resolution w/ sha512) + `bunfig.toml`
  (immutable-store note) (A).
- `…/pi-coding-agent/dist/core/extensions/types.d.ts:343-377` (no `gating`);
  `grep -rwn gating …/dist` → 0 (B).
- `…/dist/core/tools/{read,write,edit,bash}.{js,d.ts}` → no `gating` (B).
- `bun-apps/pi-agent-ext-tool-gate/types/tool-gating.d.ts` (the augmentation) (B).
- `bun-apps/pi-agent/src/patches/ext-api-get-all-tool-definitions.ts` (the hook) (C-iii).
- `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts:37-58` (CORE_TOOLS),
  `:100-128` (buildEffectiveGates), `:401-410` (getDiscovered) (C-iii).
- `…/dist/core/tools/` ships find/grep/ls too, absent from CORE_TOOLS (C-iii
  source-heuristic ruled out).
