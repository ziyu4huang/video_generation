# 07 — SDK-contract guard test: setExtensionStatus → requestRender

Carried from round-1 t06 (footer-extension-status-notify patch removed on pinned-SDK evidence — `setExtensionStatus` itself calls `requestRender`; a future pi bump that drops that internal call would silently kill footer rendering with nothing red).

## Scope

- Add a test that source-scans the PINNED pi-coding-agent dist (node_modules resolution from s2-agent's dep range) for the `setExtensionStatus` implementation and asserts it references `requestRender` (grep-level contract, resilient to formatting but specific enough to catch removal/renaming).
- Green against the CURRENT pinned dist; red the day a bump drops the call — that is the entire point. No runtime behavior change.

## Acceptance criteria

- [x] Guard test green on the current pin (run proven in-ticket)
- [x] Test fails loudly (descriptive message naming the SDK contract + what to restore) when the reference is absent — INCLUDING the symbol-extended rename case (reviewer-hardened)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; reviewer pass (With fixes → applied)
- [ ] local_ci green on a macOS box / PR merged — Linux box: only the documented macOS-only `sandbox-exec` Deploy-sh L1 gate fails (environmental); merge via Linux-box policy

## Outcome (2026-08-25)

- New `src/__tests__/sdk-contract-set-extension-status.test.ts`: resolves the PINNED dist via `createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json")` (follows update-pi.sh bumps; the subpath is Bun-lax by design — resolution change = loud red, never silent green; the reviewer-suggested bare-main resolve fails under Bun's createRequire, verified empirically), scans `dist/modes/interactive/interactive-mode.js`, cuts the `setExtensionStatus` method body at the next method-level `\n    }` close + asserts the window holds no other method signature, and matches the call as `requestRender\s*\(` — a CALL SHAPE, not a substring. Current pin (0.84.2): `setExtensionStatus(key, text) { this.footerDataProvider.setExtensionStatus(key, text); this.ui.requestRender(); }` at interactive-mode.js:1614.
- **Deliberate-red demo — reviewer-hardened, genuine receipts** (the first demo's receipt was dishonest-by-accident: it sabotaged the TEST's needle, which goes red, but a dist-side symbol EXTENSION slipped the old substring check — exactly the "renaming" the ticket promises to catch). Re-run on /tmp dist copies with the hardened matcher, actual output:
  - pristine copy → `1 pass / 0 fail`
  - `this.ui.requestRender()` → `this.ui.requestRenderSync()` (symbol extended) → `0 pass / 1 fail`
  - call line deleted → `0 pass / 1 fail`
  - in-tree real resolution → `1 pass / 0 fail`
- Loud-fail-by-design on dist reformat too: close-brace scan asserts `end > start`; window-tightness asserts no other method signature inside.
