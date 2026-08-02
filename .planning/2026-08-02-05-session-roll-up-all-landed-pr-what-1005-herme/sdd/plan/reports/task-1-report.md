# Task 1 Report — Store assembly-manifest methods (UPSP §5)

**Status:** DONE_WITH_CONCERNS (one deliberate, documented deviation — see below)
**Commit:** `feat(hermes): add MemoryStore assembly-manifest methods (prompt-provenance, UPSP §5)`
**Test summary:** `tests/store/memory-store.test.ts` → 78 pass / 0 fail; `tests/store/` → 492 pass / 1 pre-existing skip / 0 fail; `tsc --noEmit` → exit 0.

---

## What I changed

### `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts`
Added two public methods immediately after `formatProjectBlock()` (~`:1290`), before `getAllFailureEntries()`:

- `getAssemblyManifest(): { block: string; mdIds: string[] }` — `block = this.formatForSystemPrompt()` (byte-identical, no re-render). `mdIds` = deduped frontmatter ids of `memoryEntries` + `userEntries` + the post-filter active failures, harvested via `this.decodeEntry(raw).id` with `if (id)` filtering for id-less (comment-shape) entries.
- `getProjectAssemblyManifest(projectName): { block: string; mdIds: string[] }` — `block = this.formatProjectBlock(projectName)`; `mdIds` = deduped ids of `this.memoryEntries` (project store instance).

No other files touched. `buildPromptContext`, `prompt-context.ts`, and all existing renderers are unchanged.

### `bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-store.test.ts`
Appended a `describe("MemoryStore assembly manifest", …)` block **inside** the existing top-level `describe("MemoryStore", …)` (so it reuses the file's shared tmp `MEMORY_DIR`, `makeConfig()`, `writeRaw()`, `cleanSlate` before/afterEach, and `serializeMetadataFrontmatter` — exactly the construction idiom the rest of the file uses). 5 `it` tests; the first and last are the two required by the brief.

## How the fixture is constructed (matches the file's idiom)

Per the meta-brief, I read the existing tests first. The file's idiom is:
1. `writeRaw(<memoryPath|userPath|failurePath>, <frontmatter entries joined by ENTRY_DELIMITER>)` to seed disk,
2. `new MemoryStore(makeConfig())` (`makeConfig()` defaults `memoryDir: MEMORY_DIR`),
3. `await store.loadFromDisk()`.

Entries are frontmatter-stamped via the existing `serializeMetadataFrontmatter({ id, text, created, last, state? })` helper (same helper `frontmatterFailureEntry` uses), exactly as the "overflow offloads superseded" and "failure lifecycle injection filter" tests seed multi-entry files joined by `ENTRY_DELIMITER`.

The first test seeds **2 memory + 1 user + 1 active failure** entry, each with a frontmatter `id` (stable UUIDs), then `loadFromDisk()`. Dates use the file's existing `dateDaysAgo(0)` for "today".

## Test command + output

```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-store.test.ts )
```
Summary line: **`78 pass` / `0 fail` / `Ran 78 tests across 1 file. [594.00ms]`** — including all 5 new `MemoryStore > MemoryStore assembly manifest > …` cases.

Full-store regression:
```
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/ )
```
Summary: **`492 pass` / `1 skip` / `0 fail`** (the skip is a pre-existing SQLite `md_id`-uniqueness guard, unrelated).

Typecheck: `bun run check` (`tsc --noEmit`) → exit 0, no errors.

## Deviation from the brief (IMPORTANT — please review)

The brief's Step-3 code, taken literally, would **silently drop every failure id** from `getAssemblyManifest().mdIds`. I verified this empirically before deviating:

> `getActiveFailureEntries(maxAgeDays)` returns **metadata-stripped, body-only** strings (it `.map(stripMetadata)`s — confirmed at `memory-store.ts:663-675`). So in the brief's literal `pushIds(this.getActiveFailureEntries(maxAgeDays).slice(0, maxFailures))`, each `raw` is a stripped body; `this.decodeEntry(strippedBody).id` is `undefined` (no frontmatter), and the `if (id)` guard filters it out. Result: `mdIds` would contain only memory + user ids, **never** failure ids — even though failures are part of the injected block.

This contradicts three things in the spec:
1. The brief's own test comment: *"ids of the 2 memory + 1 user + 1 failure entries"* must be in `expected`.
2. The plan's docstring: *"the md_id set of EXACTLY the entries that block was built from — memory + user + **post-filter active failures**"*.
3. The plan's headline invariant — **"set↔hash consistent" / "consistent by construction"**: if the rendered `block` contains a failure block but `mdIds` omits those ids, the logged id set and the block disagree, which is precisely the inconsistency UPSP §5 is meant to prevent (and it would break for the *default* config, where failure injection is ON).

**Resolution:** For the failure portion only, I mirror `getActiveFailureEntries()`'s active+age **filter** on the **raw** `this.failureEntries` (which still carry the frontmatter `id`), then apply the exact same `.slice(0, maxFailures)` the renderer uses. The guard (`failureInjectionEnabled !== false`), the `?? DEFAULT_*` constants, and the active/age/slice selection are all identical to `formatForSystemPrompt`'s call-site — so the harvested ids are exactly the ids of the failures whose bodies are injected. I did **not** call `getActiveFailureEntries()` for id harvest (it strips), and I did **not** modify `getActiveFailureEntries()` itself (behavior-preserving — the only existing-method change is none). The `memoryEntries` / `userEntries` paths use the brief's code verbatim (those fields hold raw entries, so ids are present).

`getProjectAssemblyManifest` is implemented exactly as the brief specifies (it reads raw `this.memoryEntries`, which carry ids — no stripping issue there).

### Extra tests beyond the brief's two
The brief asks for 2 tests; I added 5. The 2 required are present (first + last). The 3 extras pin the failure-filtering path that the deviation fixes, so a future regression that reverts to the brief-literal code (dropping failure ids) would fail loudly:
- failure ids excluded when `failureInjectionEnabled: false`,
- resolved/acquired + out-of-window (`maxAgeDays`) failures excluded,
- failure id set sliced to `failureInjectionMaxEntries`.

## Self-review

- **Block-equality holds?** Yes — both methods derive `block` by calling the existing renderer (`formatForSystemPrompt()` / `formatProjectBlock(projectName)`) and asserting `manifest.block === renderer()` in the tests. The block is never re-rendered.
- **mdIds deduped?** Yes — both return `[...new Set(ids)]`.
- **mdIds filtered for missing ids?** Yes — `const id = this.decodeEntry(raw).id; if (id) ids.push(id);` skips comment-shape / malformed entries (the same `Boolean` filter the eviction path uses at `:972`).
- **Set↔hash consistency?** The `mdIds` set now corresponds 1:1 to the entries in `block`: memory + user entries are harvested from the same raw arrays the snapshot strips, and failures are harvested from the raw entries whose stripped bodies the renderer injects (same active+age filter + same slice). This is the invariant the brief names.
- **No ripple:** `buildPromptContext` / `prompt-context.ts` untouched; only the two named files changed; full `tests/store/` suite green; `tsc` clean.

## Concerns

- The failure-id deviation means Task 1's `getAssemblyManifest().mdIds` will include failure ids whenever `failureInjectionEnabled !== false` (the default). Downstream tasks (Task 2's `buildPromptAssembly` union + hash) build on this; their fixtures stub `getAssemblyManifest` with fixed `{ block, mdIds }`, so they are unaffected by the internal change. But if any later task asserts a *specific* failure-id-absent expectation derived from the brief's literal code, it would need to align with this (correct, complete) behavior. I believe complete ids is what the feature requires.
