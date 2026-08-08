# Upstream Sources for pi-agent Extensions (wayfind + superpowers)

Durable record of where the ported pi-agent extensions track their upstreams.
**Local paths are machine-specific and may move or be lost — the GitHub remotes
below are the source of truth.** Re-derive a lost checkout with `git clone <url>`.

## Superpowers extension
- **Port target:** `bun-apps/pi-agent-ext-superpowers`
- **Local working checkout (this machine):** `/Users/huangziyu/proj/pi-ext-superpowers`
- **Git remote(s):**
  - `git@github.com:obra/superpowers.git` — obra/superpowers — https://github.com/obra/superpowers
- **Canonical original upstream:** obra/superpowers — https://github.com/obra/superpowers
- **Also referenced:** primeradiant/superpowers — https://github.com/primeradiant/superpowers (cited in the port README)
- **Byte-sync pin:** obra/superpowers @ v6.2.0 (commit 3dcbd5c4, 2026-07-23) — see `bun-apps/pi-agent-ext-superpowers/tests/__fixtures__/upstream-skills/UPSTREAM.ref`
- **Local checkout at:** v6.2.0-1-g44c9b2d — 44c9b2d docs: remove the "We're Hiring" section from the README (2026-07-28 12:25:36 -0700)

## Wayfind extension (Matt Pocock's skills)
- **Port target:** `bun-apps/pi-agent-ext-wayfind`
- **Local working checkout (this machine):** `/Users/huangziyu/proj/pi-ext-matt-skills`
- **Git remote(s):**
  - `git@github.com:mattpocock/skills.git` — mattpocock/skills — https://github.com/mattpocock/skills
- **Canonical original upstream:** mattpocock/skills — https://github.com/mattpocock/skills
- **Local checkout at:** v1.2.3-2-g84fdeff — 84fdeff Merge pull request #788 from mattpocock/grill-me-align (2026-08-06 20:49:51 +0100)

---
Recorded 2026-08-08. If a local checkout moves, re-verify with `git -C <path> remote -v`
and re-clone from the GitHub URL above.
