# pi-agent-ext-distill

The ubiquitous language of pi-agent-ext-distill — the agent self-triggered knowledge-distillation engine. One `distill` tool with three actions; enrichment happens in the agent's LLM context, not in this extension. The pipeline-stage vocabulary (Gate / Enrich / Converge / Adaptive threshold) is owned by pi-agent-cli's CONTEXT (the orchestrator); this CONTEXT captures what is specific to the engine.

## Language

### The tool surface

**`distill` tool**:
One tool, three actions — `status` (report bloat + current threshold), `gate` (deterministic filter), `converge` (write enriched notes to vault + graph, auto-adjust threshold). Agent self-triggered when memory bloat exceeds the adaptive threshold.
_Avoid_: the pipeline (the pipeline is the Gate→Enrich→Converge flow; the tool is its agent-callable surface)

**Enrichment-in-agent-context**:
The defining design — enrichment (the only LLM step) happens in the driving agent's reasoning turn BETWEEN gate and converge, NOT in this extension. The engine imports no model client, reads no key, makes no provider call.
_Avoid_: LLM step, enrichment stage (it is in-the-agent enrichment, not an in-extension stage)

### Gate outputs

**Survivors**:
Entries that passed the gate's deterministic filter (dedup via fuzzy Jaccard, staleness, malformed), each with a reason, ready for agent enrichment.
_Avoid_: kept, passed (they are gate-survivors queued for enrichment)

**Killed**:
Entries the gate rejected, with a reason — `duplicate`, `stale`, or `malformed`.
_Avoid_: rejected, filtered (they are gate-killed entries with a categorized reason)

**EnrichedNote**:
An agent-enriched note ready for converge — id, type, title, detail, tags, optional dimension/confidence.
_Avoid_: note, card (it is the enriched-shape input to converge)

### Convergence

**Supersede** (mechanism B, `supersedesCardId`):
A gate survivor may carry a `supersedesCardId`; converge uses it to supersede the matching raw pi-memory card in the knowledge graph.
_Avoid_: replace, overwrite (it is a graph-supersede of a raw card)

**Threshold adjustment**:
Converge feeds `killRate` + `passRate` into the threshold (N ∈ [20,200]): high kill+pass → −5 (distill sooner); low pass → +10 (let mature); else stable. (The Adaptive threshold concept itself lives in pi-agent-cli's CONTEXT.)
_Avoid_: tuning, feedback (it is metric-driven threshold auto-adjustment)

### State

**DistillState**:
Per-vault state — the current threshold, run history (candidates/killed/survivors/converged/killRate/passRate per run), and lastRun timestamp. Read via `status`.
_Avoid_: config, settings (it is the distill run-state + threshold + history)
