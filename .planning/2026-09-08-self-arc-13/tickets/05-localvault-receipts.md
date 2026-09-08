# Ticket 05 — Local-vault trio receipts on both legs (T5)

Status: open · after t02/t03 (receipts must capture hardened behavior)

## Problem

Planner F6: `collect_news` / `organize_vault_notes` / `import_memory_to_vault`
are the operations a user runs daily; they have unit tests but ZERO receipts —
the family has never been through a receipts leg.

## Work

Receipt drivers only (same stub-ctx mechanism as t04): temp vault via
`OB_VAULT_PATH`; fixture hermes dir with 2–3 entries + one pre-existing id for
dedup. Sequence: scaffold → re-run without overwrite (guard) → organize →
import dry-run. Both legs (source factory + deployed ext-standalone).

## Done when

`output/self-arc13-localvault-src-<date>/receipt.json` and
`output/self-arc13-localvault-deployed-<date>/receipt.json` PASS named checks:
- `newsScaffoldWritten` — file exists, frontmatter + zh title, correct Saturday anchor
- `overwriteGuardRefuses` — second run action=skip, file content unchanged
- `organizeTagsNotes` — fixture note gains tags/aliases/created; orphan listed
- `importMemoryDryRun` — parsed/added/existing counts match fixtures, no file written
- `youtubeMissingKeyErrorsCleanly` — collect_videos platform=youtube returns
  isError with the YOUTUBE_API_KEY hint (deterministic; no key in env, planner F7)
