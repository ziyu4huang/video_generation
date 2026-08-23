---
type: task
blocking: 04
status: open
---

# 05 — ship file2md in the s2-agent deploy tree + OCR e2e against the deployed dist

## Question
Does the s2-agent-sh **deployed** binary run file2md OCR end-to-end — with the
tesseract-wasm core and the vendored lang data resolving from the deploy tree,
covered by an e2e test that would catch a broken wasm/asset layout?

## What to build
Flip file2md into the deploy set. The registry comment already names the shape
(`deploy.flip = asset copy fields + vendor: for the wasm __dirname locators`):
the `s2-agent.registry.yaml` entry drops `excludeReason` and gains the
`deploy:` key with `copy:`/`vendor:` entries (wired at `deploy/run.ts:630-631`)
so the deployed tree carries `dist/tesseract-core.wasm` + the vendored
`.traineddata` at the paths our locators expect. Then an OCR e2e probe rides the
existing deploy-e2e recipe: boot the deployed `s2-agent` (the verified
`cli file2md <scan.png> --extract ocr` path against the deploy tree's own
binary — no repo checkout), assert OCR text + `provenance: ocr`.

## Acceptance
- [ ] Deploy `--list`/`deploy.json` includes file2md with the exclusion gone and
      the `copy`/`vendor` entries carried in the deploy output
- [ ] Deployed tree contains `tesseract-core.wasm` and `eng.traineddata` at the
      paths `src/ocr/ocr.ts` resolves (`node_modules/tesseract-wasm/dist/...`
      equivalent + vendored lang dir) — verified by the probe, not by inspection
- [ ] e2e probe: the DEPLOYED binary runs `cli file2md <fixture.png> --extract
      ocr` and the page md contains the fixture text with `provenance: ocr`
      (gate integrated or invoked via `verify-deploy-e2e-cli.ts` / deploy-e2e
      recipe; deterministic, offline, catches wasm-locator or lang-data regressions)
- [ ] Deploy-sh L1 e2e gate stays green end-to-end (the existing boot/ext/model
      probe unaffected)
- [ ] Package canonical `bun run test` + typecheck green; merge chain via devops
      with exact `--scope`; effort/ticket docs updated

## Out of scope
- VLM/vision tier in the deploy (optional local server — remains a runtime
  choice, not a shipped asset).
- Splitting the OCR wasm/lang data into a separate small bundle — one package's
  OCR assets ride `copy:`/`vendor:` as designed.
