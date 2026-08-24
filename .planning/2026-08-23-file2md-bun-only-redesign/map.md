---
effort: 2026-08-23-file2md-bun-only-redesign
created: 2026-08-23
last: 2026-08-23
status: done
---
# file2md v2 bun-only redesign — machine-bound chain out, pure-Bun local stack in

## Destination

`s2-agent-ext-file2md` converts PDF / image / docx / xlsx / pptx / ipynb / text
files to structured markdown with a **complete bun-only** stack — zero native
npm modules, zero postinstall downloads, zero macOS toolchain, zero Swift, and
network-free except the OPTIONAL local vision tier. The deploy registry keeps
file2md + devops EXCLUDED from the portable `s2-agent-sh` tree (measured below:
already working) with refreshed, honest reasons, and the package structure is
deploy-ready so shipping later is a config-only flip.

## Context (measured 2026-08-23 on this machine, bun 1.4.0)

- **v1 was machine-bound at four sites**: `mupdf` npm (wasm downloaded at install — `src/native/pdftext.ts`), macOS PDFKit/pdf2image rasterization (`src/native/pdf2png.ts`, embedded Swift string), Swift Vision OCR binary (`src/image/ocr.ts`), plus a hard LM Studio requirement. That is the registry's old `excludeReason` ("mupdf native/wasm + a hard LM Studio localhost dependency").
- **Deploy exclusion ALREADY worked**: `bun-apps/s2-agent/src/registry-config.ts` has no `deploy:` block for file2md or devops and both carry `excludeReason`; `~/proj/dist/s2-agent-sh/current` (outRoot, `deploy.json` — deployed build `0.2.7+gb9cf6b4e` from worktree `video_generation__deploy`) ships 17 included / 9 excluded, both names in the report's "Extensions — excluded" table; `s2-agent-ext-devops/tests/deploy-report.test.ts:162-177` pins file2md + devops in `excludedExtensions()` with non-empty reasons. Registry identical across this branch and the deploy worktree (`diff` empty).
- **Reference projects cloned** (learned, not vendored wholesale): `agent-tools-lab/markdown-converter` (`/tmp/mdconv-ref`) — local conversion hub + tesseract assets (its runtime rolls `@napi-rs/canvas` — a native Rust module — itself ~60MB assets → rejected as the stack, adopted as the design reference); `Jesse-njx/dsh-cowork` (`/tmp/dsh-ref`) — user's own MIT project, `packages/core` = 72KB pure-TS sniff/extract/window with safety caps and bounded windows.
- **Spikes (all passed, offline)**: (a) vendored dsh-cowork core bundles under `bun build --format=cjs` — 298 modules / 3.37MB, sniff executes under node + bun; (b) tesseract.js@7.0.0 worker (worker_threads) runs under Bun 1.4, offline OCR of a text PNG; (c) full scanned-pdf chain: pdf-lib embed → pdfium wasm raster → BGRA→BMP (own encoder) → tesseract OCR → "FILE2MD OCR SPIKE 12345".
- **Dist root layout facts**: bun workspace uses ISOLATED linker + globalStore (`bun-apps/bunfig.toml`) — a vendored dir with its own package.json does NOT get its deps installed (phantom-hygiene); the snapshot must have NO package.json and its bare deps declared by the consuming package (jszip was the live lesson).
- **CLI `--mode` is taken** (`text|json` output mode, `args.ts`) — the pipeline mode reuses `--extract` with new values; the tool param is `mode`.

## Tickets

- `tickets/01-deploy-alignment.md` — **closed** (2026-08-23) — registry `skills: true` + refresh of file2md's excludeReason (v2 rationale: size/scope policy, deploy-ready); `bun-apps/s2-agent/docs/deploy.md` Limits refresh; devops unchanged.
- `tickets/02-vendored-stack-and-spike.md` — **closed** (2026-08-23) — vendored `@dsh-cowork/core@0.1.0` snapshot (src + LICENSE + VERSION + README, no package.json per the linker lesson) + `vendored/ocr-assets/` (eng 2.8MB + chi_sim 1.6MB gz + licenses); deps added: exceljs, jszip, mammoth, pdfjs-dist, tesseract.js, @hyzyla/pdfium (+ dev pdf-lib); biome excludes `vendored`.
- `tickets/03-pipeline-v2.md` — **closed** (2026-08-23) — `src/core/{types,sniff,pdf-text}.ts`, `src/raster/{bmp,png,pdf}.ts`, `src/ocr/ocr.ts`, new `runFile2mdPipeline` (modes text/ocr/vlm, provenance markers, resume/manifest contract kept, office via vendored windows, csv→table + html→markdown-lite); `src/native/*`, Swift `ocr.ts`, `vlm/{extract-strategy,figure-annotate,figure-detect,page-context}` deleted; OCR lang normalization fixed at the session level (worker requests `lang.traineddata.gz` verbatim — `en` → ENOENT until normalized).
- `tickets/04-tools-cli-docs-tests.md` — **closed** (2026-08-23) — tool params `mode/note/scale/lang` (v1 `extract/dpi/mode` gone); CLI twin + `args.ts`/`flag-spec.ts` (`--extract` new values, `--note`, `--lang`, `--scale`); `skills/file2md/SKILL.md`; README/PRD/CONTEXT/architecture v2; `docs/adr/0001-vendored-bun-only-stack.md`; 5 new test files (sniff/raster/ocr/convert/pipeline-v2 + helpers/docs.ts) replacing 8 stale ones, `--isolate` kept; build-bundle self-verify param list updated.

## Decisions

- **D1 — vendored snapshot, archify precedent.** `vendored/dsh-cowork-core@0.1.0/` pinned (MIT, user's own project); "no dependency on the upstream source after vendor-copy"; its pure-JS deps are ordinary deps. Rejected: markdown-converter runtime wholesale (`@napi-rs/canvas` native + 60MB assets), mupdf keep, text-only-without-OCR (user chose vendored tesseract OCR — eng/chi_sim fast models, ~4.4MB).
- **D2 — pdfium wasm for raster, own encoders.** `@hyzyla/pdfium` (pure wasm, MIT, 11MB unpacked) replaces PDFKit/pdf2image; pdfium renders BGRA → two ~60-line pure TS encoders: BMP (OCR, zlib-free) and PNG (vision, node:zlib + CRC32). Rejected: `@napi-rs/canvas` (native), raw FPDF bindings (glue cost).
- **D3 — vision is now optional, tier-based.** Only `mode vlm` resolves the model (`resolveModelRole` via `sessions.ts`, unchanged); text/ocr never touch a server; per-page vision degrades to OCR, OCR degrades to an explicit notice.
- **D4 — surfaces stable by contract.** `file2md`/`vision_ask` tool names, gate family `file2md`, `pi:knowledge` emission, `slugify`/manifest/`DocLayout` for `pdf-to-vault` stage-1 resume — all kept; only the pipeline entry renamed (`runVlmDescribePipeline` → `runFile2mdPipeline`) with all three call sites updated.
- **D5 — per-page PNG lives only for the vision path** (raster was never needed for text/OCR pages); OCR pages keep `provenance: ocr` and no png in the manifest.
- **D6 — CLI flag reuse.** `--mode` is the CLI output mode (taken) → pipeline mode rides `--extract auto|text|ocr|vlm`; note style rides `--note`; `--scale` replaces `--dpi` (float 0.1–16, validated in args.ts).

## Frontier

None — effort closed the same day. Next workable follow-ons (unowned): (1) a future deploy flip needs `deploy:` block fields (vendor/`copy` for pdfium + tesseract wasm `__dirname` locators — the unpdf precedent); (2) `vision_ask`-style single-shot `file2md` `--json` output; (3) markdown-converter-style hub outputs (md→docx/xlsx) are explicitly out of scope v2.

## Fog of war

- Deployed `current` (`0.2.7+gb9cf6b4e`) was built from the deploy worktree (another session's WIP: `cc-parity-task-ext`); **this effort did not run a real deploy** — exclusion invariants are covered by the devops test, not by a fresh deployed artifact.
- Whether tesseract's `worker_threads` spawn survives a future Bun regression — fallback documented (Bun.spawn bun child) in the ADR; not measured.
- pdfjs emits a benign `standardFontDataUrl` warning for non-embedded standard fonts during text extraction (output unaffected in smoke).

## Cross-effort links

- Builds-on: `.planning/2026-08-23-deploy-platform-neutral-core` (bun-bundle core shape the exclusion is measured against), `.planning/2026-08-21-archify-view-pptx-bun` (the vendored-snapshot precedent).
- Shares-decision-with: `.planning/2026-08-20-develop-pipeline-v2` / `2026-08-20-pi-agent-optimization` — no; the consumer contract discussed here (pdf-to-vault stage 1) is owned by `.planning/2026-07-31-let-s-continue-to-improve-base-on-known-upstream` lineage.
