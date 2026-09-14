# Local tarball diff — pi 0.84.4 → 0.85.1 (authoritative, npm dist)

Sources: `@earendil-works/pi-coding-agent/-/pi-coding-agent-{0.84.4,0.85.1}.tgz` (+ pi-ai, pi-agent-core, pi-tui), downloaded 2026-09-14 from registry.npmjs.org. Upstream dates: 0.85.0 = 2026-09-04, 0.85.1 = 2026-09-05.

## Symbol-surface diff vs OUR imports (the breakage check)

Method: extracted `export (declare)? (class|function|const|type|interface|enum) X` from every `dist/**/*.d.ts` of both versions; intersected with the ~103 distinct symbols s2-agent imports (repo-wide grep of `from "@earendil-works/pi-*"`).

- **REMOVED-and-USED: ∅ (empty).** Nothing we import was removed in any of the 4 packages.
- pi-coding-agent removals = the 0.85.1 "experimental client/plugin subpaths now source-only" cleanup: `createCodingAgentHarness`, `RemoteSession*` (7 symbols), `experimentalCli`, `PiCommand*`, `ClientCommand*`/`ServerCommand*`, `parseAuth*`, `TranscriptState`, `applyTranscript*`, `BuildCodingAgentHarnessSystemPrompt*`, `AuthInput`, `Command*` family. **We import none of them** (verified).
- pi-ai removals: `AiGateway*` family + `createGatewayBindingFetch` — unused by us.
- pi-agent-core: heavy churn (102 removed / 350 added) but our only imports are `AgentToolResult`, `ThinkingLevel` — both present in 0.85.1 (`dist/core/*.d.ts`, 618 symbols).
- pi-tui: purely additive (17 added, 0 removed).

Additions visible to us: `ChatViewport`/`createChatViewport`, `ToolRenderers` + per-tool `*Renderers` (`createShellRenderers` etc.), `ThemeJsonValidator`/`validateThemeJson`/`ThemeColorValue`, `setupCli`, `getLatestVersion`, `InteractiveTuiOptions`, `CustomEditorOptions`, `EditRenderState`.

## New API of note (verified in 0.85.1 d.ts)

`core/session-manager.d.ts:334`:
```ts
static inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[]): SessionManager;
```
0.84.4 had `inMemory(cwd?, options?)` — **the `entries?: FileEntry[]` restore parameter is NEW** in 0.85.x ("Restorable in-memory sessions"). Shipped docs/sdk.md adds exactly this example:
```ts
// Resume a session kept outside the filesystem, e.g. in a database
const { session: restored } = await createAgentSession({
  sessionManager: SessionManager.inMemory(process.cwd(), { id: sessionId }, entries),
});
```
s2-agent already calls `SessionManager.inMemory()` (bun-apps/s2-agent-core-runtime/src/agent.ts:446) — upgrade is backward compatible; the entries param is opt-in.

## Behavior changes that could bite (from shipped CHANGELOG + docs diffs)

1. **`setModel` / `setThinkingLevel` are now session-scoped** (docs/extensions.md): change is recorded in session history and restored on session resume, but no longer changes the configured `defaultProvider`/`defaultModel` for NEW sessions. ⚠️ Audit any place s2-agent relies on ctx.setModel leaking across sessions/children.
2. RPC `abort` now **waits for idle** before responding (docs/rpc.md) — latency change for RPC drivers that abort.
3. 0.85.1 fix: SDK import failures from 0.85.0's unintentionally-published experimental code — the supported local SDK + stdio RPC API unchanged (confirmed by the removal list above).
4. Tools `bash/edit/find/grep/ls/read/write` now honor `ctx.cwd` (0.85.0) — children spawned with a different cwd should now resolve paths correctly (improvement for us).
5. Session forks preserve their compaction boundary (0.85.0 fix); in-memory session forks before an active turn settles (fix); imported sessions no longer overwrite same-filename sessions; concurrent session shares don't clobber.
6. Branch summaries fixed when reasoning consumes the previous 2048-token output cap.
7. Custom editors: standalone working row kept by default; `{ embedWorkingStatus: true }` opts into editor-border spinner (pi-tui).
8. GPT-6 Astra model (OpenAI API + Codex); GPT-5.6+ Responses long-prompt-cache `ttl: "30m"` fix; persistent Claude thinking effort on Anthropic transports; Alt+wheel 5× faster scroll.

## Mechanical bump scope

`0.84.4` appears in **~28 package.json files** under bun-apps/* (both `dependencies` and `peerDependencies`, all four `@earendil-works/pi-*` names). One scoped sed per filename covers it; then `bun install` refreshes the lockfile.
