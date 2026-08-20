# s2-agent-ext-movie-director

The ubiquitous language of s2-agent-ext-movie-director — an agent-first video production pipeline (a Bun port of OpenMontage). The agent IS the orchestrator, reading pipeline manifests + stage skills; Bun/Swift-MLX is only the tools and persistence. Iteration 1 is the orchestration core (manifests, gates, schema validation, cost); media bridges land later.

## Language

### Orchestration model

**Agent-first**:
The defining posture — the agent reads YAML pipeline manifests + stage skills and drives the run; code is only tools + persistence. A 1:1 fit for s2-agent (already an agent runtime), so orchestration is a pi-extension, not a hardcoded script.
_Avoid_: tool-first, script-driven (the agent holds the control flow, not a pipeline engine)

**Pipeline**:
A manifest-defined chain of stages — `idea/research → proposal → script → scene_plan → assets → edit → compose → publish`. The shape of one production.
_Avoid_: workflow (reserved for s2-agent-ext-workflow), job, DAG (a pipeline is a manifest-authored stage chain driven by the agent)

**Stage**:
One step of a pipeline, producing a canonical artifact and gated by a checkpoint.
_Avoid_: step, phase (a *phase* is a plan-execution unit; a *stage* is a pipeline unit)

**`dispatch()`**:
The single orchestration core — the 18 commands the `movie` agent tool, the standalone CLI, and the `movie.*` workflow host-fns all call. One code path, three entry points.
_Avoid_: handler, router (it is the shared orchestration entry, not a dispatcher table)

### Gates & artifacts

**Checkpoint**:
The gate-enforced record of a stage's status (written/read via `write-checkpoint` / `read-checkpoint`). Completing a stage requires writing one.
_Avoid_: save, state (it is a gate-enforced stage record)

**The gate** (binding rule):
`write-checkpoint status="completed"` on a stage whose manifest has `human_approval_default=true` is **rejected** unless `humanApproved=true`. The one hard enforcement — the agent cannot silently skip a human-approval gate.
_Avoid_: validation, check (it is a binding approval enforcement)

**Human-approval gate**:
A stage whose default policy requires explicit `humanApproved` before it can be marked complete.
_Avoid_: approval step, review (it is a manifest-declared policy gate)

**Artifact**:
A stage's canonical output (7 total across the pipeline), validated against a bundled OpenMontage JSON schema (`validate-artifact`).
_Avoid_: output, file (it is a schema-validated stage deliverable)

### Generation

**Director**:
A native generation bridge — `krea2-image-director`, `flux2-image-director`, `ltx-video-director` — invoked by `generate` under a capability. The Swift/MLX-native tools that replaced OpenMontage's Python.
_Avoid_: provider, generator (a director is a native MLX bridge; a provider is the registry entry)

**Capability**:
The generation axis a director serves — `image_generation`, `video_generation`, `audio`, `subtitle`, `analysis`. The first selector into the provider registry.
_Avoid_: type, mode

**Provider registry**:
The explicit map of capabilities → directors (+ ffmpeg/cloud providers). `preflight` rolls it up into a provider menu.
_Avoid_: factory, catalog (it is an explicit capability→director map)

### Compose

**Compose tiers**:
The four compose paths — `compose` (ffmpeg straight-cut, always available), `compose-remotion` (templated: ken-burns/zoom/pan, crossfades, title overlays via a Remotion subprocess), `compose-motion` (lightweight ffmpeg `zoompan`+`xfade`, no browser), and `pre-compose`.
_Avoid_: render modes, export options

**pre-compose**:
The deterministic gate run before the expensive render — checks the delivery promise, slideshow risk (static-image fraction), and cut-duration-vs-source (a video cut out-running its source clip, which `compose-motion` would silently freeze-extend). `verdict:"fail"` → don't render.
_Avoid_: dry-run, validation (it is a pre-render risk gate)

### Cost

**Cost lifecycle**:
The budget tracker's three phases — `cost-estimate` → `cost-reserve` → `cost-reconcile` (with `cost-snapshot` for state). Tracks media `$`, distinct from a workflow's token `budget`.
_Avoid_: billing, accounting

### Resilience

**Crash-resumable**:
A `/command` run persists a journal after every `agent()` and `call('movie.*')` step; a killed run (`kill -9`, kernel panic, power loss) is auto-recovered on next start (`recoverStaleRuns` reconciles `"running"` → `"paused"`, never `"failed"`) and resumable by replaying the journal prefix.
_Avoid_: restartable, durable (it is journal-replay resume, not mere restart)

### Learning loop

**`evaluate-lipsync`**:
Scores an already-produced talking-head video's mouth-motion-vs-audio
correlation (Swift `ltx-video lipsync-metrics`, resolved/built via
`ensureBinary()` — no Python) and returns a `lesson`
(`{target, category, content, reason?}`) shaped for hermes-memory's `memory`
tool. Decoupled from how the video was produced — call it after any
`native-i2v` + `run.py video lipdub` pair.
_Avoid_: generate hook (lipdub is not a `generate` provider today — see
`evaluate-lipsync`'s own `movie_help` entry for why)

**Lesson**:
The output of `evaluate-lipsync` — `target: "memory"|"failure"`,
`category: "insight"|"tool-quirk"`, `content`, `reason?`. When present, call
hermes-memory's `memory` tool immediately with these fields so the finding
survives the session. Before producing a NEW lipdub video, call
hermes-memory's `memory_search` tool first (`category: "tool-quirk"`) to
check for known-bad combinations.
_Avoid_: silent skip (a `lesson` field left unrecorded defeats the entire
point of this loop — see `evaluate-lipsync`'s `movie_help` entry)

### Integration

**`movie.*` host-fns**:
When loaded alongside `s2-agent-ext-workflow`, the 20 `dispatch()` commands are exposed as `movie.<command>` callable from any workflow script via `call('movie.<command>', args)` — deterministic, zero-token, journaled.
_Avoid_: workflow tools, bindings (they are deterministic host-functions inside the workflow vm)

**Tool-scope guard**:
A PreToolUse handler that blocks the built-in `edit`/`write` tools from repo infra roots (`python/`, `swift/`, `mlx-models/`, `bun-apps/`, …) during a `movie` run — prevents the ungrounded-edit class.
_Avoid_: sandbox, permissions (it is a path denylist on edit/write during a run)
