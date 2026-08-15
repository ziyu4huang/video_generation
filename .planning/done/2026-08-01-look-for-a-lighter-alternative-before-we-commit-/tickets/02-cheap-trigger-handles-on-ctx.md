---
type: research
claimed:
---
## Question

Beyond heavyweight `ctx.reload()`, **what lighter explicit-trigger handles does
`ctx` (the command's `ExtensionCommandContext`) expose** to force a prompt-only
rebuild after `/response-language` writes `settings.json`?

### Investigate

- Enumerate the session-control surface on `ctx` (`types.d.ts:248-340`):
  `getSystemPrompt()`, `getSystemPromptOptions()`, `reload()`, `invalidate()`,
  `newSession`, `fork`, `switchSession`. Is the **raw session** exposed, or
  `_rebuildSystemPrompt` / `setActiveToolsByName` reachable?
- Does `setActiveToolsByName(this.getActiveToolNames())` (which calls
  `_rebuildSystemPrompt`, `agent-session.js:643`) constitute a cheap prompt-only
  rebuild, and is it reachable from the command? What does it cost vs `reload()`?
- Is there any `ctx.session` / internal handle the command can use to call
  `session._rebuildSystemPrompt()` + reassign `state.systemPrompt` directly?
- Cost comparison: `reload()` does settings reload + `resetApiProviders()` +
  `_resourceLoader.reload()` + `_buildRuntime(includeAllExtensionTools)` +
  session_start emit + `extendResourcesFromExtensions`. Which of those are
  unavoidable for a *language* change vs incidental?

### Resolve

Whether a prompt-only rebuild is reachable from the command handler without a full
runtime reload, and its cost. If the only reachable trigger is `reload()`, state
that explicitly (feeds the fallback decision in ticket 04).

### Deliverable

Reachability + cost verdict for a cheap explicit trigger — yes (with the handle) or
no (`ctx.reload()` is the only option).

## Resolution (closed)

**Verdict: NO cheap prompt-rebuild handle is reachable from `ctx`.** The full
`ExtensionCommandContext` surface (`types.d.ts:248-300`, plus inherited
`ExtensionContext`) is exactly:

`getSystemPromptOptions()`, `waitForIdle()`, `newSession()`, `fork()`,
`navigateTree()`, `switchSession()`, `reload()` + inherited `getSystemPrompt()`,
`getContextUsage()`, `compact()`, …

- **No** raw session exposed. **No** `_rebuildSystemPrompt` reachable.
- **No** `setActiveToolsByName` reachable (it's a session method, not on ctx).
- The ONLY thing that triggers a prompt rebuild through ctx is `reload()` — and
  that is the full heavyweight runtime rebuild (settings + `resetApiProviders()` +
  `_resourceLoader.reload()` + `_buildRuntime(includeAllExtensionTools)` +
  session_start emit + `extendResourcesFromExtensions`).
- `compact()` is exposed but is destructive (triggers compaction), not a clean
  language-change lever.

**Implication:** Candidate B (cheap explicit trigger via ctx) is **not viable**.
The choice collapses to **Candidate A** (per-turn injection, no trigger — ticket 01
shows it's cleanly patchable) **or the fallback** (keep `ctx.reload()`). Since 01
makes A viable and universal, A is the clear winner; `ctx.reload()` is retained
only as the fallback if A proves fragile in ticket 04.
