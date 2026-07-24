## Question

Build the **savings measurement** that answers "does tool-gate's ~8,500 tok/req
claim actually hold?" — and lock the design decision that hangs off it.

**Mechanism (mostly settled — confirm):** import
`@repo/pi-agent-ext-power-tool/schema-cost` (zero-dep, capturing-mock API, no
agent boot). Token estimate = `(desc.length + JSON.stringify(params).length) / 4`.

**The decision to resolve here — baseline definition + authority:**
- *Baseline* = tool-gate OFF (every tool always active, the ungated world).
  Confirm this is the right reference, not "CORE_TOOLS only."
- *Gated* = tool-gate ON at session start (only `CORE_TOOLS` + sticky fired
  gates active; since nothing has fired yet at start, this is ~`CORE_TOOLS`).
- Produce **both** numbers: the static schema-cost estimate AND, if feasible,
  reconcile with tool-gate's runtime `savedTok` telemetry — and flag any
  divergence (this graduates the "baseline-authority" fog on the map).

**Deliverable:** a function/script in the tool-gate package that, given the
registered tool set, prints `{ baselineTok, gatedTok, savedTok, savedPct }` and
asserts `savedTok` is in the neighbourhood of the claimed ~8,500. Lives where
ticket 02 will assemble it, but standalone-runnable now.

**type:** task
**blocked by:** —
**claimed:** wayfind-session (2026-07-23) — ✅ CLOSED

## Resolution

Built `qa/savings.ts` (`measureSavings` + `formatSavings` + `assertSane` +
``caveats`) in the tool-gate package, wired as `bun run qa:savings`. Reuses
`buildSchemaCostReport` from `pi-agent-cli/src/commands/schema-cost.ts`
(capturing-mock collection, no agent boot) + `CORE_TOOLS`/`GATES` from the
extension. Exit 0; 83 existing tests still pass.

### Finding — the ~8,500 tok/req claim does NOT hold

Measured on `scratch/post-vault-fix`:

```
OFF baseline:   14,388 tok/req  (45 tools, all active)
ON at start:     8,834 tok/req  (tool-gate ON, nothing fired)
SAVED:           5,554 tok/req  (38.6%)
vs README ~8,500:  −2,946 tok  (~35% short)
```

**The savings are real but overstated by ~35%.** The baseline itself also
drifted from the README (41 tools/~18,500 tok → 45 tools/14,388 tok — leaner
descriptions / changed toolset), independent of the gate.

`5,554` is a **lower bound** — two gates don't contribute:
- **workflow gate** → collection error: the workflow factory dereferences
  `pi.events.on`, but schema-cost's capturing mock returns `undefined` for
  `events` (expects a guard). **Instrument gap**, not tool-gate's bug.
- **zai-mcp gate** → not registered on this branch (absent from manifest
  discovery), so contributes 0 to runtime savings too.

Even adding workflow's estimated ~700 tok (by analogy to sibling gates) →
~6,250 tok, still ~2,250 short of the claim.

### Authority finding — clears map fog "baseline-authority divergence"

No heuristic-level divergence exists: tool-gate's runtime `savedTok` telemetry
(`computeBannerSaved` → `measureToolTokens`) uses the **identical**
`(desc+params)/4` heuristic as offline schema-cost, so the two agree *by
construction*. The only possible divergence is **set membership** (captured vs
live registered set) — exactly the workflow/zai-mcp gaps above. Fog cleared.

### Implications handed forward

- **Ticket 02** (harness skeleton): the savings track is `bun run qa:savings`;
wire its output into the unified gate/report.
- **Ticket 05** (verdict): savings dimension is real-but-overstated; the
  verdict must state actual (~5.5–6.3k) not the claim. Correcting the
  README/banner text is **out of scope** (we verify, not fix) — flag as a
  follow-up.
- **Out-of-scope side-finding** (potential follow-up issue): the schema-cost
  capturing mock should tolerate `pi.events.on` (or the workflow extension
  should guard `if (!pi.events)`). Not tool-gate's bug; recorded for awareness.

**Asset:** `bun-apps/pi-agent-ext-tool-gate/qa/savings.ts` +
`bun-apps/pi-agent-ext-tool-gate/package.json` (`qa:savings` script).
