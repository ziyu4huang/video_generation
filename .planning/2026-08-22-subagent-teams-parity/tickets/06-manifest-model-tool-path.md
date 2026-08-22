# Ticket 06 — manifest-model-tool-path

status: open

## Goal

Apply `manifest.model` when a pack is run via the `run_workflow` tool `name` path
(PRD.md:74-76 future work, seam pre-charted at `workflow-tool.ts:439-441`).

## Steps

1. `s2-agent-ext-ultracode/src/workflow-manager.ts` — `ExecOptions.mainModel?` (:103),
   threaded ahead of the manager-level `mainModel` in the runtime modelSpec resolution
   (`workflow-runtime.ts:265-270`).
2. `workflow-tool.ts:507-513` — pass `resolved.manifest?.model` into exec options.
   Precedence: script per-agent `model` > `manifest.model` > session mainModel.
3. `toPersistedExec` (:167) serializes the new field (background-run resume).
4. Update `PRD.md:74-76`.

## Tests

- Extend pack/model-resolution tests (fake agent runner asserting resolved spec per
  precedence; persisted-run round-trip keeps mainModel).

## Acceptance

ultracode `bun run test` green; scopedModels clamping unaffected (downstream of
resolution).
