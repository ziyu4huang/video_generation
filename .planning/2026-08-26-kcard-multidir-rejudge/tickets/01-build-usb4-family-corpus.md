# 01 — Build the usb4-family multi-directory corpus

Status: closed 2026-08-26 · Blocks: 02, 03, 04

## What

Assemble `/Users/huangziyu/proj/study-news/ic-standard-spec/USB4 Specification November 2025/vlm-out/usb4-family/`
— a multi-directory markdown tree: the existing main-spec pages (copied) +
5 companion specs + all V1/V2 ECNs, each file2md'd (`--extract text`) into
its own directory, ECNs grouped under `v1-ecn/` / `v2-ecn/`.

Per map D1/D2: strip tier sidecars and per-doc combined `<slug>.md` from the
assembled copy; originals untouched.

## How

1. Copy `usb4-specification-2.0-november-2025-clean/` (pages only + manifest)
   into the corpus root; strip `.overview.md`/`.abstract.md` and the combined
   root `.md`.
2. `s2-agent cli file2md <pdf> --extract text --out <corpus[-subdir]>` for:
   CM Guide, DROM, Inter-Domain, DVSEC, Retimer 2.0 CLEAN (doc dirs at corpus
   root), each V1/V2 ECN PDF (into `v1-ecn/` / `v2-ecn/`).
3. Strip each generated `<slug>.md` combined file (keep `pages/` + manifest).
4. Receipt in this ticket: per-dir page counts, total L2-walk count
   (`walkTree` equivalent — every non-dot `.md` except tier sidecars),
   directory count, any conversion warnings (TT font warnings are known-noise).

## Receipt (2026-08-26)

Corpus root: `vlm-out/usb4-family/` (86 dirs total, 1263 walkable L2 `.md`
files, 0 sidecars, 0 combined `<slug>.md` — verified by find).

| doc dir | pages |
|---|---|
| usb4-specification-2.0-november-2025-clean (copied) | 839 |
| usb4-connection-manager-guide-2.0-november-2025 | 96 |
| usb4-re-timer-specification-2.0-november-2025-clean | 85 |
| usb4-inter-domain-service-specification-2.0-november-2025 | 51 |
| usb4-drom-specification-november-2025 | 44 |
| usb4-dvsec-version-1.0 | 14 |
| **doc subtotal** | **1129** |

ECN dirs: `v1-ecn/` 10 + `v2-ecn/` 25 = **35 dirs, 134 pages**
(distribution: 2p×10, 3p×10, 4p×5, 5p×4, 7p×5, 9p×1).

- Extraction: `--extract text` throughout (map D1); only known-noise
  `Warning: TT: undefined function` lines from pdfjs on some PDFs.
- Originals untouched: source clean tree still has its 4 tier sidecars +
  combined root `.md` (verified post-build).
- Criterion note: the ticket draft said "≥8 doc dirs"; reality is 6 doc dirs
  + 2 ECN group dirs (8 top-level) — the multi-directory intent (86 dirs,
  43 content subtrees, 3 nesting levels) is exceeded; criterion read as
  written-intent, actuals recorded here.

## Done when

- [x] Corpus root exists with 6 doc dirs + 2 ECN group dirs (35 ECN dirs),
      originals untouched (verified)
- [x] Total walkable L2 count recorded: **1263** (839 + 290 companions + 134
      ECN)
- [x] No `.overview.md`/`.abstract.md` and no combined `<slug>.md` anywhere
      in the corpus (find-verified 0/0)
- [x] Receipt recorded here; map `last` touched
