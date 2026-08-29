# 04 — help banner adjudication

blocking: none

## What

`--help` introduces the tool as "pi - AI coding assistant" with `pi
install/remove/update` usage lines. Decide: patch the face through the
patches seam (maintained across upstream bumps) vs document-only. Record the
maintenance-cost rationale; implement the minimal slice if patch wins.

## Measurement receipt (2026-08-30, main `14d1b90f` + t03, dist `0.8.0+gb894dc9`)

**The premise is half-stale: only the SOURCE face says "pi". The DEPLOYED
face — the user-facing one — already introduces the agent as `s2-agent`.**

- Deployed (`<outRoot>/darwin-arm64/current/s2-agent.js --help`): banner
  reads **`s2-agent - AI coding assistant with read, bash, edit, write
  tools`**; every usage line says `s2-agent install/remove/update/…`. This
  rides the UPSTREAM-SUPPORTED rename seam: `piConfig.name: "s2-agent"` in
  `bun-apps/s2-agent/package.json` → upstream `config.js` derives
  `APP_NAME`/`APP_TITLE`/usage strings from it. No repo patch involved; it
  has survived every pi bump since the 2026-08-22 rename (0.7.x → 0.84.4
  core, dist 0.8.0).
- Source (`./s2-agent.sh --help`): banner reads `pi - …`. Cause: source
  mode resolves the UPSTREAM pi-coding-agent package.json
  (`getPackageJsonPath()` → upstream package dir, which carries no
  `piConfig.name`) — in dev you are literally running upstream's CLI.
- Deployed-face residual "pi" strings are ALL D4 non-residue classes:
  `update [source|self|pi]` (names the upstream binary it updates),
  `~/.pi/agent` example path (factual config dir, unchanged by design),
  `S2-AGENT_CODING_AGENT_DIR` (our own derived env var — the documented
  dash trap), `PI_SHARE_VIEWER_URL` → `pi.dev/session/` (upstream
  ecosystem URL).

## Decision (D6) — DOCUMENT-ONLY, no patch

The banner is already correct where users meet it, via the seam upstream
maintains for exactly this. Patching the source face through the patches
seam would add a patch to carry across every pi bump (0.84.2→0.84.4 churned
internals twice this week) to fix a developer-only surface that is
factually upstream's own CLI name in dev mode. Cost > value; refuse. The
`piConfig.name` seam + its env-var consequence is documented in
`extension-naming` SKILL.md so the mechanism is discoverable without
re-deriving.

## Done when

- [x] Map decision with rationale (patch vs document) — D6: document-only
- [x] If patch: banner + usage lines only, pinned by test, survives a
      version-bump dry check — N/A (no patch; the deployed-face rename is
      seam-driven and measured green on dist 0.8.0)
