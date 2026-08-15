type: task
blocked by: 01-publish-face-decision

## Question

Migrate `pi-agent-ext-webui` to a src package root — the pilot proving the mechanical recipe
on the one package with no publish complications.

Mechanics (evidence at `48eb08a7`):

- `package.json`: `main: ./dist/index.js`, `exports["."] → ./dist/index.js`, plus `./src/*` →
  repoint root to `./src/index.ts` (types included); drop `"build": "bunx tsc"` as a required
  step and remove `build &&` from `"test": "bun run build && bun run test:unit"` (tests must
  pass from src directly).
- `tsconfig.json` `outDir: dist` — decide keep (harmless) vs delete with the build script.
- Verify: canonical `bun run test` green from src; cross-package typecheck green;
  `./pi-agent.sh -p` boots (static-extensions.ts imports the entry relatively — should be
  untouched); boot log shows no `ensure-workspace-dist` rebuild for webui (heal's
  `distEntryMain` returns null once root points at src).

## Resolution

**Done.** Changes: package.json root fields (`main`/`types`/`exports["."]`) → `./src/index.ts`;
dropped `"build": "bunx tsc"` and the `build &&` prefix from `test`; removed `outDir: dist`
from tsconfig; README gate line updated. Package was already `private: true` (decision 01-b
needed no field change here). No bare-spec root consumers existed (grep: only the
`workspace:*` dep declaration + a doctor.ts comment).

Verification (2026-08-15, all at `48eb08a7` + this diff):

- canonical `bun run test`: **373 pass / 0 fail** from src — re-run **after
  `rm -rf dist/`**: still 373 pass / 0 fail (src independence proven, not assumed).
- `bun run typecheck` green; pi-agent cross-package `bun run typecheck` **exit 0**.
- `./pi-agent.sh -p` boots clean: `BOOTOK` reply, zero NameTooLong / stale / rebuild
  warnings — and still `STILLBOOTOK` with dist/ deleted.

Recipe proven for tickets 03/04: flip root fields, drop build from scripts, drop `outDir`,
update README gate line, verify (canonical test → typecheck → cross-pkg typecheck → boot →
delete dist → re-test).

Ticket closed 2026-08-15.
