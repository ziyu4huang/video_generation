## Question

Owner-declare `gating` on every tool belonging to `deploy` (`bun-apps/pi-agent-ext-deploy/extensions/deploy.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: pi_deploy, pi_verify). Then remove `deploy`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `deploy` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02
claimed: main-session

## Resolution

Migrated deploy: owner-declared `gating` on `pi_deploy` and `pi_verify` (mirrored from the hardcoded GATES entry — it was a 2-name gate, NOT two separate gates, and neither name was in `CORE_TOOLS`; so the SAME `{keywords, requires}` went on EACH tool with no `core`): `keywords: ["build bundle", "bundle pi-agent", "pi-agent bundle", "run-test"]` + `requires: { nouns: ["bundle", "pi-agent", "pi agent", "extension"], verbs: ["build", "deploy", "verify", "bundle", "部署", "建置", "驗證", "打包"] }`. Removed the whole `pi_deploy`/`pi_verify` gate from hardcoded `GATES`; appended `deploy` to `MIGRATED_EXTENSIONS` (registrar = the deploy default factory `deployExtension(pi)`, matching the power-tool/tool-gate pilot pattern). Drift-guard net now validates pi_deploy + pi_verify's owner-declared gating (new per-extension test).

**Surprise (first of its kind):** `pi_deploy` was the first migrated tool ALSO covered by the L1 QA probe corpus (`qa/probes.ts`). The corpus's `qa/evaluate.ts` resolved gates only from the hardcoded `GATES`, so removing `pi_deploy`'s gate made `findGate("pi_deploy")` throw → `evaluateCorpus()` aborted during test collection → ~78 corpus tests failed to register (suite dropped 251→173, 1 fail / 7 errors). Fixed `evaluate.ts` to reconstruct migrated gates from owner-declared `gating`: capture each migrated extension's tool defs via a stub `pi` (mirrors drift-guard's capture), then group tool names sharing an identical gating signature (`keywords`+`requires`) into ONE multi-name gate — the corpus's `names[0]` model. `pi_deploy`+`pi_verify` reconstruct back into the identical multi-name gate, so the probe suite validates the EFFECTIVE gate set unchanged (33/33 must-fire, 19/19 must-not-fire, 10/10 escape-name/intent, 0 coverage gaps). This scales to tickets 04–12: each appends its registrar to the capture list, its former gate reconstructs, and its probes stay live with NO probe edits (sibling names stay characterized by `names[0]` — no per-sibling probe explosion).

Tool-gate suite green: **252 pass / 0 fail** (was 251; +1 = the deploy drift-guard net test). Deploy package suite green: **21 pass / 2 skip / 0 fail**.

status: closed
