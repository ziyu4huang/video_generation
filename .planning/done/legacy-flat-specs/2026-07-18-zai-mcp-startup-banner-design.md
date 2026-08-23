# Design: zai-mcp startup message → obsidian-style above-editor banner

## Problem

`bun-apps/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts` announces a successful
session start with:

```ts
ctx.ui.notify(
  `zai-mcp ready — ${n} tool(s) from ${m} server(s):\n${formatToolList(...)}`,
  "warning",
);
```

The `"warning"` type is a documented hack. The inline comment admits why: pi's
`notify("info", …)` merges consecutive startup notifies (later overwrites
earlier), so back-to-back extension startup messages clobber each other.
`notify("warning", …)` always appends, so it was misused to keep zai-mcp's line
visible — at the cost of a scary `Warning: zai-mcp ready …` toast for what is
really an info confirmation.

## Goal

Adopt the proven pattern from the sibling obsidian extension
(`pi-agent-ext-obsidian/src/obsidian-lib.ts` → `scheduleVaultBanner`): a
**transient above-editor banner** via `ctx.ui.setWidget(key, lines)`, delayed
past the startup notify burst, auto-dismissed, and stale-ctx-guarded. No
`"Warning:"` prefix, no footer pin.

## Reference pattern (obsidian, the source of truth)

```ts
export function scheduleVaultBanner(ctx, line: string): void {
  const SHOW_DELAY_MS = 10_000; // past the startup notify burst (zai-mcp)
  const DISPLAY_MS = 8_000;     // visible window before auto-dismiss
  setTimeout(() => {
    try { ctx.ui.setWidget("obsidian-vault", [line]); }
    catch { return; }                        // ctx stale after session switch
    setTimeout(() => {
      try { ctx.ui.setWidget("obsidian-vault", undefined); } catch {}
    }, DISPLAY_MS);
  }, SHOW_DELAY_MS);
}
```

Key invariants to preserve:
1. **Keyed widget** (`setWidget`) — independent of `notify()`'s merge behavior;
   multiple extensions' banners never clobber each other (different keys).
2. **Both deferred `ctx.ui` calls guarded** with `try/catch`. A session switch
   (`/resume`, `ctx.fork`, `ctx.switchSession`) between schedule and fire leaves
   `ctx` stale; `ctx.ui`'s `assertActive()` throws → uncaughtException → pi
   crashes. The banner is non-essential, so swallow.
3. **Default placement** (`aboveEditor`) — same spot as the `/goal` banner.

## Scope

Single file: `bun-apps/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts`.
No change to obsidian, no shared module (each extension stays self-contained).

### Messages that become a banner

| Case | Today | After |
|---|---|---|
| Success (tools > 0) | `notify("…ready…", "warning")` | 2-line banner |
| No tools registered (tools === 0, non-fatal) | `notify("…no tools…", "warning")` | 1-line warning-toned banner |

### Messages that stay an immediate notify (actionable problems)

| Case | Today | After |
|---|---|---|
| Missing `@modelcontextprotocol/sdk` | `notify(…, "error")` + return | unchanged |
| `ZAI_API_KEY` unset | `notify(…, "warning")` + return | unchanged |
| Per-server connection failed | `notify(…, "error")` (in loop) | unchanged |

Rationale: these need the user to act *now* (install a dep, set a key, fix
network). A delayed banner would bury them. Mirrors obsidian, which keeps its
own hard-failure catch as `notify("obsidian: no vault found", "warning")`.

## Concrete change

1. **Add `scheduleReadyBanner(ctx, lines: string[]): void`** in `zai-mcp.ts`,
   mirroring obsidian's helper, local to this file (no export, no shared lib):
   - `SHOW_DELAY_MS = 5_000` — shorter than obsidian's 10s so zai-mcp lands
     first; obsidian's vault banner then stacks at 10s. Both keyed widgets, so
     no collision; brief 10–13s overlap shows both confirmations together.
   - `DISPLAY_MS = 8_000` — matches obsidian.
   - `ctx.ui.setWidget("zai-mcp", lines)` then `setWidget("zai-mcp", undefined)`.
   - Both deferred calls wrapped in `try/catch` (stale-ctx guard).
   - Accepts `lines: string[]` (1 or 2 lines) instead of obsidian's single line.

2. **Success path** — replace the `notify("…ready…", "warning")` block with:
   ```ts
   const theme = ctx.ui.theme;
   scheduleReadyBanner(ctx, [
     theme.fg("accent", `🛰 zai-mcp ready — ${n} tool(s) · ${m} server(s)`),
     theme.fg("dim", registeredToolNames.join(" · ")),
   ]);
   ```

3. **No-tools path** — replace `notify("…no tools…", "warning")` with:
   ```ts
   const theme = ctx.ui.theme;
   scheduleReadyBanner(ctx, [
     theme.fg("warning", "⚠ zai-mcp: no MCP tools registered (check ZAI_API_KEY / network)"),
   ]);
   ```
   (A banner, not a toast — so no `Warning:` prefix; the `⚠` glyph + warning
   color carry the tone.)

4. **Delete** the now-obsolete multi-paragraph "Type is warning on purpose"
   comment block above the success notify.

5. **Keep** the `formatToolList()` helper? After the change the success banner
   joins names with `" · "` inline, so `formatToolList` (bullet-per-line) is no
   longer used. **Remove it** to avoid dead code.

## API confirmation

From `@earendil-works/pi-coding-agent` types (`core/extensions/types.d.ts`):
- `setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void` — default placement `aboveEditor`.
- RPC/print modes implement `setWidget: () => {}` (silent no-op) → graceful degradation, no crash, no output. Same effective behavior as today's invisible notify in non-interactive modes.
- `ctx.ui.theme: Theme`; `Theme.fg(color: ThemeColor, text: string): string`; `ThemeColor` includes `"accent" | "dim" | "warning" | …`.

## Edge cases

- **Session switch mid-delay** — both `setTimeout` callbacks swallow stale-ctx throws. (Same guard obsidian ships + unit-tests in `__tests__/banner-stale-ctx.test.mjs`.)
- **`/resume` / fork** — replacement session renders its own banner on its own `session_start`; the orphaned timers from the prior session harmlessly no-op via the guard.
- **All servers disabled (`WEB_SEARCH_ENABLED=0` etc.)** → `registeredToolNames` empty → no-tools banner path fires (1 warning line).
- **RPC / print mode** — `setWidget` is a no-op; startup is silent. Acceptable (matches today).
- **Theme unavailable** — `ctx.ui.theme` is always present on `ExtensionContext` in interactive mode; in non-interactive modes the whole banner is a no-op anyway, so `theme.fg` is never reached.

## Testing

- **Unit** (new): `extensions/__tests__/startup-banner.test.ts` — a fake `ctx`
  with a capturing `setWidget`, advancing timers (`bun:test` fake timers) to
  assert (a) banner appears at 5s with the expected 2 lines, (b) clears at 13s,
  (c) stale-ctx (setWidget throws on second call) does not throw out of the
  helper. Mirrors obsidian's `banner-stale-ctx.test.mjs` shape.
- **Existing** `stealth-trim.test.ts` is unaffected (it does not touch the
  startup notify).
- **Manual**: `ZAI_API_KEY` set → `bun run dev` in gui-movie-director (or any pi
  interactive session) → confirm a clean `🛰 zai-mcp ready …` banner above the
  editor ~5s in, auto-dismissed ~8s later, with no `Warning:` toast.

## Debug verification mode

`ZAI_MCP_DEBUG_BANNER` lets you confirm the trigger + rendered message **without**
an interactive TTY, `ZAI_API_KEY`, or network — useful for headless / CI checks.

| Value | Behavior |
|---|---|
| `1` (or any non-`empty`) | Skip real connection; fire the **success** banner immediately with synthetic tools (`zai_web_search_web_search_prime`, `zai_web_reader_webReader`) |
| `empty` | Skip real connection; fire the **no-tools** banner immediately |
| unset / `""` | Normal path (unchanged) |

In debug mode `scheduleReadyBanner` is called with `{ immediate: true, log: true }`:

- `immediate` → `SHOW_DELAY_MS = 0` (fires now, not at 5s).
- `log` → `console.error(\`[zai-mcp banner]\\n${lines.join("\\n")}\`)` mirrors the
  rendered lines (incl. ANSI colors) to stderr, so the trigger is observable
  in print/RPC/noOpUIContext where `setWidget` is a silent no-op.

Both are options on the existing helper (optional 3rd arg); prod calls omit
`opts`, so the tested happy/stale paths are unchanged. Verified end-to-end with
a throwaway harness driving the real `session_start` handler (see commit).

## Out of scope

- No change to obsidian's helper or its 10s delay.
- No shared banner utility package (revisit only if a 3rd extension wants it).
- `setStatus()` / footer status bar: explicitly rejected (would pin a permanent
  footer entry — the original comment's reason).
