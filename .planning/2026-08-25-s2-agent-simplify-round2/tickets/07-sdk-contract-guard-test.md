# 07 — SDK-contract guard test: setExtensionStatus → requestRender

Carried from round-1 t06 (footer-extension-status-notify patch removed on pinned-SDK evidence — `setExtensionStatus` itself calls `requestRender`; a future pi bump that drops that internal call would silently kill footer rendering with nothing red).

## Scope

- Add a test that source-scans the PINNED pi-coding-agent dist (node_modules resolution from s2-agent's dep range) for the `setExtensionStatus` implementation and asserts it references `requestRender` (grep-level contract, resilient to formatting but specific enough to catch removal/renaming).
- Green against the CURRENT pinned dist; red the day a bump drops the call — that is the entire point. No runtime behavior change.

## Acceptance criteria

- [ ] Guard test green on the current pin (run proven in-ticket)
- [ ] Test fails loudly (descriptive message naming the SDK contract + what to restore) when the reference is absent
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; local_ci green; PR merged via devops chain; reviewer pass
