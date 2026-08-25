# 07 — SDK-contract guard test: setExtensionStatus → requestRender

Carried from round-1 t06 (footer-extension-status-notify patch removed on pinned-SDK evidence — `setExtensionStatus` itself calls `requestRender`; a future pi bump that drops that internal call would silently kill footer rendering with nothing red).

## Scope

- Add a test that source-scans the PINNED pi-coding-agent dist (node_modules resolution from s2-agent's dep range) for the `setExtensionStatus` implementation and asserts it references `requestRender` (grep-level contract, resilient to formatting but specific enough to catch removal/renaming).
- Green against the CURRENT pinned dist; red the day a bump drops the call — that is the entire point. No runtime behavior change.

## Acceptance criteria

- [x] Guard test green on the current pin (run proven in-ticket)
- [x] Test fails loudly (descriptive message naming the SDK contract + what to restore) when the reference is absent
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; local_ci green; PR merged via devops chain; reviewer pass

## Outcome (2026-08-25)

- New `src/__tests__/sdk-contract-set-extension-status.test.ts`: resolves the PINNED dist via `createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json")` (follows update-pi.sh bumps), scans `dist/modes/interactive/interactive-mode.js`, cuts the `setExtensionStatus` method body at the next method-level `\n    }` close, asserts `requestRender` inside it. Current pin (0.84.2): `setExtensionStatus(key, text) { this.footerDataProvider.setExtensionStatus(key, text); this.ui.requestRender(); }` at interactive-mode.js:1614.
- **Deliberate-red demo** (acceptance 2): symbol sabotaged to `requestRenderGONE` → 0 pass / 1 fail with the contract-naming message; reverted → green. Receipt above.
- Loud-fail-by-design on dist reformat too: the close-brace scan asserts `end > start` (a false red a human re-verifies beats a silent green — header documents the choice).
