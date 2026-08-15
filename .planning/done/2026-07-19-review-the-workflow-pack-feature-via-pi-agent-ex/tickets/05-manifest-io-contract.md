## Question

What **manifest fields** declare the I/O contract — input source(s), output target/policy, intermediate policy, and history retention — and what is their exact schema/types? This is the spine: 06, 07, 11, 12, 13, 14 all read through it.

type: prototype
status: closed
claimed: work-session (2026-07-19)

blocked by: _(none — frontier)_

## Context

`src/workflow-pack-manifest.ts` currently validates only `name`/`description`/`entry` + optional `args`/`model`/`thinking`/`howToRun`/`kind`/`engine`. The flat layout (04) gave the contract a *directory* form; this ticket gives it a *declarative* form in the manifest so the engine + agent can read it without inferring from folder presence. Decide: how does the manifest point at `inputs/` (a dir glob? an explicit list? an external path?), how does it declare output naming/versioning (relates to 11), how does it express intermediate + run retention (relates to 06). Keep `validateManifest` the single gate; preserve the `"key" in manifest` soundness property (absent ≠ undefined). Backward compatible (all new fields optional).

## Resolution

**Hybrid declaration model + polymorphic I/O, nested under `io:`.** All new fields **optional**; absent → defaults from the flat dir convention (04). `validateManifest` stays the single gate; `"key" in manifest` soundness preserved; unknown enum values throw.

```jsonc
{
  // existing required
  "name": "...", "description": "...", "entry": "entry.js",
  // existing optional unchanged
  "args": {}, "model": "...", "thinking": "...", "howToRun": "...",
  "kind": "workflow-pack", "engine": "pi-agent-ext-workflow",
  // NEW (this ticket)
  "version": "0.1.0",                 // groundwork; SCHEME decided in 08 (05 only allows it as optional string)
  "io": {                             // optional object; absent → dir-convention defaults
    "inputs":  "inputs/" | [{ "name": "...", "path": "...", "required": true }],  // polymorphic; default "inputs/"
    "outputs": { "dir": "outputs/", "naming": "timestamped|versioned|overwrite" },  // semantics → 11
    "intermediate": { "persist": true, "purge": "always|on-success|manual" },        // mechanics → 06/12
    "runs": { "dir": "runs/", "keep": 10 }                                            // retention defaults → 06
  },
  "agents": "agents/*.md" | ["agents/*.md"]   // registration + claude-compat form → 09
}
```

Validation rules owned by 05 (extend `validateManifest` / `workflow-pack-manifest.ts`):
- `io` optional object; `io.inputs` = string **or** array of `{name:str, path:str, required?:bool}`; `io.outputs` = `{dir?:str, naming?:enum}`; `io.intermediate` = `{persist?:bool, purge?:enum}`; `io.runs` = `{dir?:str, keep?:int≥0}`.
- `agents` = string **or** string[].
- `version` = optional string (format strictness deferred to 08).
- All optional; absent ≠ undefined preserved; bad types / unknown enums → throw with field name.

**Scope boundary (anti-bleed):** 05 owns **schema + field vocabulary only**. Semantics live downstream — `naming` meanings → **11**; `purge`/`keep` defaults + the clean/purge command → **06**; on-disk `intermediate.persist` mechanics + the determinism/resume tension → **12**; `agents` registration + the `tools` interop form → **09**; `version` scheme → **08**.

**Why polymorphic inputs:** the user picked the hybrid "explicit interface" model; polymorphism lets a trivial pack use `"inputs/"` while a pack wanting real repeat-run identity (11's same-input detection) lists named slots (hashable). String shorthand = low ceremony; named slots = real interface — both supported, validated.
