---
id: "gui-review:extract-shared-helper-eliminates-duplication-class"
created: 2026-06-21
tags: [zettel, lever, code-quality, duplication, refactor, fix-applied, single-source-of-truth, process]
sources: ["workflow-knowledge-jsonl:gui-movie-director-review-optimize"]
source: "workflow-knowledge-jsonl:gui-movie-director-review-optimize"
source_id: "gui-review:extract-shared-helper-eliminates-duplication-class"
record_type: lever
status: active
superseded_by: 
confidence: 0.95
dimension: code-quality
---
# Extracting a duplicated guard/expression into a single shared helper PERMANENTLY closes the whole fix-not-ported-to-sibling-sites recurrence class

## 核心想法
When the same logic is copy-pasted across N files (CORS allowlist in routes.ts+ws.ts; containment checks across paths/caption/gallery; reconnect-timer clear in useWebSocket+wsClient), re-flagging the unfixed sibling run after run is the dominant review-loop tax. FIX APPLIED 2026-06-21T03-54 (effort:medium+fix:true) on the CORS-allowlist duplication: created lib/origin.ts with `originAllowed(origin, host): boolean` (LOOPBACK_HOSTS const + port-from-Host regex + DEFAULT_PORT=3099 in ONE place), routes.ts and ws.ts both import + call it. This structurally ELIMINATES the cross-origin-allowlist-duplication recurrence — there is now only one site to fix. The two prior distinct 403 response bodies were preserved by checking !host after originAllowed returns false (originAllowed encodes 'absent Origin -> allow, absent host -> deny'). LESSON (load-bearing): the 'extract shared helper' refactor is strictly stronger than the 'grep-port the fix to siblings' rule (fix-not-ported-to-sibling-sites) — grep-porting depends on a human remembering every sibling each time; extraction makes the single-source-of-truth structurally enforced by the compiler/import graph. PREFERENCE ORDER for a recurring duplication-driven finding: (1) extract a shared helper and call it from all sites (permanent); (2) grep-port the fix to siblings (manual, recurrence-prone); (3) leave duplicated (re-flagged forever). Same lever applies to containment-check-reimplemented (4 sites) and the WS reconnect-timer (2 sites) — both are extract-helper candidates. Verified safe: 574/0 tests, tscDelta=0, no regressions. NEW DUPLICATION INSTANCES this run (2026-06-23T22-35) all confirm the lever: (a) QUANT_SUFFIX_RE + normalizeTransformerKey duplicated byte-identical between api/abTest.ts and frontend/utils/galleryGroup.ts (quant-suffix detection would drift on a new suffix like nf4); (b) /output/<N>/<file> URL parse+dirIdx-bounds+path.join copy-pasted 3x (caption.ts x2, abTest.ts resolveGalleryUrl x1); (c) subprocess stdout/stderr concurrent-drain pattern (new Response(stream).text() before await proc.exited) repeated verbatim in 4 files with the same ~64KB pipe-buffer comment; (d) loopback host allowlist [localhost,127.0.0.1,::1] hardcoded in api/config.ts AND api/vlm.ts AND lib/origin.ts (3 copies, two bare '::1' vs one bracketed) — origin.ts was created to be the single source but config.ts/vlm.ts did not adopt it; (e) VLM model id constants (PREFERRED_VLM/DEFAULT_VLM) hardcoded in api/vlm.ts with a 'mirror caption.py manually' comment (drift hazard, no sync test); (f) stderr truncation magic number 300/200 scattered across gallery/abTest/knowledge-extractor. All are extract-helper candidates: promote resolveGalleryUrl→shared lib/paths.resolveOutputUrl, spawnCapture→shared lib/subprocess.captureSpawn, quant regex→shared module, adopt origin.ts LOOPBACK_HOSTS in config.ts+vlm.ts.

## 證據 / 脈絡
- type: lever
- confidence: 0.95
- status: active
- occurrences: 2
- first_seen: 2026-06-21T03-54-14
- last_seen: 2026-06-23T22-35-42
- extracted_at: 2026-06-23T22-35-42
- provenance: workflow-knowledge-jsonl:gui-movie-director-review-optimize

## 連結
- 相關：[[gui-review-fix-not-ported-to-sibling-sites]]
- 相關：[[gui-review-cross-origin-allowlist-duplication]]
- 相關：[[gui-review-route-table-over-ifelse-chain]]
- 相關：[[gui-review-containment-check-reimplemented]]
- 相關：[[gui-review-routes-handler-ifelse-chain]]
- 相關：[[gui-review-csrf-host-header-rebinding]]
- 相關：[[gui-review-degenerate-ternary-both-arms-identical]]
- 相關：[[gui-review-fix-mode-baseline-shifted]]
