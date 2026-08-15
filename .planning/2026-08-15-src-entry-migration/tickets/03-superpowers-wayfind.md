type: task
blocked by: 02-webui-pilot

## Question

Migrate `pi-agent-ext-superpowers` and `pi-agent-ext-wayfind` to src package roots using the
pilot recipe from ticket 02, carrying the publish decision from ticket 01.

Package-specific extras:

- **superpowers**: entry is already a 1-line shim to `../src/index.js`; only root fields move.
- **wayfind**:
  - Fix the dangling `pi.extensions: ["./extensions/index.ts"]` (no such file — should be
    `wayfind.ts` or dropped per the one-canonical-entry rule).
  - `build` is `bun run architecture:vendor && bunx tsc` — determine whether the vendored
    `vendor/mermaid.min.js` (gitignored, 3.4 MiB) is consumed from `src/` at dev time. If yes,
    the vendor script must survive independent of tsc (e.g. `"pretest"`/`postinstall` or
    document in README); if dist-only, it can go with the build.
  - Vendor step has a user-facing failure mode if `scripts/vendor-mermaid.ts` needs network —
    keep it offline-safe or lazy.
