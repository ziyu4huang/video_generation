# Task 5 Report: Docs (README + PRD)

## Summary

Added documentation for the `inspect_hooks` tool to both `README.md` and `PRD.md` in `pi-agent-ext-power-tool`.

## Changes Made

### README.md

#### Change 1: Updated extension description (line 2)
**Anchor:** First paragraph, description of registered tools
**Text added:** Added `inspect_hooks` to the comma-separated list of diagnostic tools

**Before:**
```
A **pi extension** for agent self-diagnostics — `inspect_agent`,
`inspect_context`, `inspect_extensions`, `inspect_pathology`. The `src/index.ts`
factory registers only these four tools (plus the `schema-cost` export and a
CLI subcommand).
```

**After:**
```
A **pi extension** for agent self-diagnostics — `inspect_agent`,
`inspect_context`, `inspect_extensions`, `inspect_hooks`, `inspect_pathology`. The `src/index.ts`
factory registers only these five tools (plus the `schema-cost` export and a
CLI subcommand).
```

#### Change 2: Updated Feature surface table (Diagnostics row)
**Anchor:** Feature surface table, Diagnostics row
**Text added:** Added `inspect_hooks` to the diagnostics tools list

**Before:**
```
| Diagnostics | `inspect_agent`, `inspect_context`, `inspect_extensions` | Static state diagnostics — documented ↓ |
```

**After:**
```
| Diagnostics | `inspect_agent`, `inspect_context`, `inspect_extensions`, `inspect_hooks` | Static state diagnostics — documented ↓ |
```

#### Change 3: Added full `inspect_hooks` section (before `inspect_pathology`)
**Anchor:** Between `inspect_extensions` section and `inspect_pathology` section
**Text added:** Complete documentation section with description, parameters table, output description, usage examples, and design notes

**Full text added:**
```markdown
---

### `inspect_hooks`

Lists every loaded extension's registered `pi.on(...)` lifecycle hooks (which events each extension listens on, handler counts) and flags any handler registered against an unknown event name (likely a typo / dead handler). Fact-finder companion to `inspect_extensions`.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `by_event` | boolean? | `false` | Group hooks by event instead of by extension |
| `return_json` | boolean? | `false` | Return machine-readable JSON instead of a text report |
| `self_test` | boolean? | `false` | Run built-in self-test and report results |

**Output:**

- **By extension (default):** For each loaded extension, shows the events it listens on and handler counts per event
- **By event (`by_event=true`):** Groups all hooks by event name, showing which extensions subscribe to each
- **Unknown event detection:** Medium-severity finding for any handler registered against an event not in the known event set

**Usage:**

```bash
# Default: show hooks grouped by extension
call inspect_hooks

# Group by event to see which extensions listen to each event
call inspect_hooks by_event=true

# Machine-readable JSON
call inspect_hooks return_json=true

# Run self-test
call inspect_hooks self_test=true
```

**Design notes:** Reads the aggregated `runner.extensions[].handlers` via a `getHooks()` polyfill on `sdk-patch.ts`'s `createContext` wrapper. Phase 2 (future): add firing counts and `never-fired` detection.

---
```

### PRD.md

#### Change 1: Updated Tools table
**Anchor:** Tools section, table row
**Text added:** Added `inspect_hooks` row between `inspect_extensions` and `inspect_pathology`

**Before:**
```
| `inspect_extensions` | Lint loaded extensions/tools/skills for health issues |
| `inspect_pathology` | Detect failure patterns this session (retry loops, error storms, saturation) — F v1 |
```

**After:**
```
| `inspect_extensions` | Lint loaded extensions/tools/skills for health issues |
| `inspect_hooks` | List registered lifecycle hooks per extension and detect unknown event names |
| `inspect_pathology` | Detect failure patterns this session (retry loops, error storms, saturation) — F v1 |
```

#### Change 2: Added inspect-* section with inspect_hooks subsection
**Anchor:** Before the "Use" section
**Text added:** New `## inspect-*` section with `### inspect_hooks` subsection

**Full text added:**
```markdown
## inspect-*

### inspect_hooks

Hook observability for extension development — the last blind spot of the
inspect surface. Phase 1 (this work): registration listing + `unknown-event-name`
typo detection, reading the aggregated `runner.extensions[].handlers` via a
`getHooks()` polyfill on `sdk-patch.ts`'s `createContext` wrapper.

Phase 2 (follow-up plan, same effort): firing counts — wrap each handler with a
counter at the same patch point, add the `never-fired` (registered-but-dead)
finding. The patch point is shared, so the scaffolding lands once in phase 1.
```

## Self-Review

### ✅ Spec coverage
- README entry includes: tool description, all 3 parameters (`by_event`, `return_json`, `self_test`), output formats, usage examples, design notes with phase-2 mention
- PRD entry includes: Phase 1 description (registration listing + typo detection), implementation detail (sdk-patch.ts polyfill), Phase 2 follow-up plan (firing counts + never-fired detection)
- Matches brief markdown blocks exactly

### ✅ Placement and organization
- README: `inspect_hooks` positioned between `inspect_extensions` and `inspect_pathology` (logical flow: extensions → hooks → pathology)
- README: Updated all 3 locations where tool lists appear (intro paragraph, Feature surface table, and full section)
- PRD: Added to Tools table in correct alphabetical/functional order
- PRD: New `## inspect-*` section created before "Use" for clarity

### ✅ Markdown quality
- Proper heading levels maintained (### for tool sections)
- Table syntax correct (pipes, alignment)
- Code blocks properly fenced with ```bash or ```markdown
- No duplicate entries
- Consistent formatting with existing tool sections

### ✅ Accuracy
- All parameter names and defaults match implementation
- Design notes accurately reflect the SDK patch approach
- Phase-2 description aligns with D-decision from SDD
- No typos or factual errors

### ✅ English language
- All text in English as required
- Clear, concise descriptions
- Consistent terminology with existing docs

## Conclusion

All documentation additions are complete, accurate, and properly formatted. The `inspect_hooks` tool is now fully documented alongside the other `inspect_*` tools, with clear usage examples and the phase-2 follow-up plan noted in the PRD.
