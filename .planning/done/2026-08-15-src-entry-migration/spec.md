# Spec — Src-entry migration (kill the stale-dist class)

> STATUS: approved 2026-08-15. Evidence line refs verified at `origin/main` (`48eb08a7`)
> via a breadth-first Explore pass (21 tool uses; report summarized in map.md Notes).

---

## §1 Scope

Four `@repo/*` packages still resolve their package root to a gitignored `./dist/index.js`:
`pi-agent-ext-workflow`, `-superpowers`, `-wayfind`, `-webui`. Everything else in the monorepo
already runs from src. That residue is the entire habitat of the **stale-dist bug class**:

- **2026-08-15 incident** (cf6f1394): `homeDir` removed from the subagent barrel; workflow's
  stale gitignored `dist/workflow-paths.js` still imported it → the extension graph failed
  native import → jiti transform fallback base64-wrapped a >4 KB module → cryptic
  `ResolveMessage: NameTooLong` at boot, movie-director un-loadable. Documented at
  `bun-apps/pi-agent/src/workspace-dist-staleness.ts:5-15`.
- The class is **invisible to remote CI by construction** (dist gitignored → always fresh in
  CI); it only bites dev machines — hence the two band-aids shipped today: the
  `ensure-workspace-dist` boot heal patch and the `bun run test:dist` local-CI gate
  (`bun-apps/tests/workspace-dist-fresh.test.ts`).

This effort removes the habitat instead of patrolling it. When the last root points at src,
a stale dist is unloaded by definition, and the band-aids retire or become explicit no-op
guards.

**Discovery fact that shrinks the work**: the four `extensions/<X>.ts` registered entries
already import `../src/*.js` (static-extensions.ts imports them relatively, bypassing
`exports` entirely). The dist exposure is exactly the `package.json` root fields
(`main`/`types`/`exports["."]`) — what bare-specifier consumers resolve.

## §2 The one decision, then four mechanics tickets

### Ticket 01 — publish face (grilling, HITL gate)

Three of the four are publish-ready npm ports (workflow even carries the upstream
`repository` field and `prepublishOnly`; superpowers/wayfind have `publishConfig.access:
public`). npm cannot ship a `.ts` root, so the root flip must pick: **(a)** `publishConfig`
override (dev root src, publish root dist, `prepublishOnly` builds) or **(b)** drop
publishability (`private: true`). Input: whether anything installs these from npm. Webui has
no publish face and is exempt from the decision.

### Ticket 02 — webui pilot (task)

Repoint root fields to `./src/index.ts`, un-require the tsc build (drop `build &&` from
`test`), verify canonical tests + cross-package typecheck + clean boot. Proves the recipe on
the zero-publish-complication package.

### Ticket 03 — superpowers + wayfind (task)

Same recipe under ticket 01's decision. Extras: fix wayfind's dangling `pi.extensions:
["./extensions/index.ts"]` (no such file); settle the `architecture:vendor` mermaid step —
keep it if `vendor/mermaid.min.js` is dev-time-consumed from src, drop it with the build
otherwise; keep it offline-safe either way.

### Ticket 04 — workflow + consumers (task)

The only package with live bare-specifier root consumers (pi-agent CLI commands + 3 test
files, movie-manager + 3 tests — the incident graph). Each consumer starts resolving to src
automatically; verify each, collapse `workflow-command.test.ts`'s deliberate src-bypass back
to the plain specifier, and delete pi-agent's `package.json:22` postinstall dist-presence
heal for workflow.

### Ticket 05 — retire the machinery (task)

`workspace-dist-fresh.test.ts`'s vacuity guard (`checked > 0`) fails once no dist entries
remain — flip it into a **zero-dist-entries tripwire** (a re-added dist entry is a regression
this effort exists to prevent) or retire it. Same decision for the `ensure-workspace-dist`
boot patch (+ PATCH_TABLE wiring, env var, heal-loop tests from #1370, `test:dist` root
script). Then `/wayfind done` closes the effort and updates the deferred-prize ledger.

## §3 Verification bar (every ticket)

1. The package's canonical `bun run test` script (not a hand-assembled subset).
2. Cross-package typecheck green (`test-pi-agent` gate red-lights the whole repo).
3. `./pi-agent.sh -p` boots clean (no NameTooLong, no ensure-workspace-dist rebuild warnings).
4. `.planning/2026-08-15-src-entry-migration/` artifacts ride the PR.
5. Merges via the devops chain (`prepare_branch` → `pr-finish`); local_ci scoped (≤5 min
   budget).

## §4 Out of scope

Remote GitHub Actions re-enablement; the Bun `@repo/*` symlink-rewrite race; ActivityRow
work (belongs to `2026-08-15-snapshot-row-single-source`).
