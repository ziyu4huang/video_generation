# pi-hermes-memory — Knowledge-Layer Role

> pi-hermes-memory is **loosely coupled** to
> [`pi-knowledge-card`](../../pi-knowledge-card) by design: it is the only
> consumer that treats the knowledge graph as an **optional enhancement**, not
> a requirement. When pi-knowledge-card is present, hermes converges memory
> entries into the shared graph; when absent, it degrades to writing an archive
> file.

## The coupling shape (optional peer + dynamic import)

```jsonc
// package.json
"peerDependencies":      { "pi-knowledge-card": "*" },            // any version
"peerDependenciesMeta":  { "pi-knowledge-card": { "optional": true } },
"devDependencies":       { "pi-knowledge-card": "workspace:*" }  // local for dev/test
```

```ts
// src/store/vault-converge.ts  (~line 129)
const kc = await import("pi-knowledge-card/src/ingest.ts");
ingestRecordsFn = kc.ingestRecords;
// → on throw (package absent):
//   { ok: false, reason: "pi-knowledge-card / pi-obsidian not installed;
//    use the archive file + zk_ingest handoff" }
```

## Why `*` and not `workspace:*` in peerDependencies?

hermes is **publishable standalone** to npm; `workspace:*` is meaningless
off-repo. The loose `*` + `optional: true` flag is the canonical "enhancement
if present" pattern. `devDependencies: workspace:*` pins the local copy for
repo dev/test. **This is intentional loose coupling, not a version-drift
hazard.**

## What hermes feeds the graph

`vault-converge.ts` adapts hermes memory entries into `ConvergeRecord`s
(structurally compatible with pi-knowledge-card's `KnowledgeRecord`) and calls
`ingestRecords` so memory joins the SAME convergence folder as workflow-jsonl
records — a hermes feedback memory and a flux2 gotcha sharing a tag get a
`## 連結` edge. The `memory-tool.ts` archive handoff is the fallback when the
graph is unavailable.

## Cross-links

- Canonical dependency graph (incl. why hermes is the SOFT edge):
  [`../../pi-knowledge-card/docs/DEPENDENCIES.md`](../../pi-knowledge-card/docs/DEPENDENCIES.md)
- The convergence primitive hermes calls:
  [`../../pi-knowledge-card/src/ingest.ts`](../../pi-knowledge-card/src/ingest.ts)
- Data model (the record shape hermes adapts to):
  [`../../pi-knowledge-card/docs/DATA-MODEL.md`](../../pi-knowledge-card/docs/DATA-MODEL.md)
- PR history (ebd6afd7 added auto-memory/dir ingest — the second source):
  [`../../pi-knowledge-card/docs/PR-HISTORY.md`](../../pi-knowledge-card/docs/PR-HISTORY.md)
