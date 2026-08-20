# zai-mcp

Z.ai [MCP](https://modelcontextprotocol.io) servers wrapped as a [pi](https://pi.dev)
package. The extension acts as an **MCP client** (using
`@modelcontextprotocol/sdk`) and re-registers each tool exposed by the configured
Z.ai MCP servers as a normal pi tool that the LLM can call directly.

pi has no built-in MCP integration, so this package provides the bridge.

## Why

The Z.ai MCP servers (also configured under `~/.claude-glm/`) expose useful
capabilities:

| Server | Transport | Endpoint | Tools (example) |
|--------|-----------|----------|-----------------|
| `web-search-prime` | http | `https://api.z.ai/api/mcp/web_search_prime/mcp` | web search |
| `web-reader` | http | `https://api.z.ai/api/mcp/web_reader/mcp` | fetch / read a URL |
| `zread` | http | `https://api.z.ai/api/mcp/zread/mcp` | read & parse (phase 2) |

> Phase 3 adds the stdio server `zai-mcp-server` (`bunx -y @z_ai/mcp-server`).

## Setup

### 1. API key

All Z.ai servers authenticate with a bearer token. Export it:

```bash
export ZAI_API_KEY=...        # your Z.ai / Z.AI API key
```

Without it, every server skips registration gracefully (the agent is notified
and the footer status bar shows `zai-mcp: no ZAI_API_KEY (disabled)`, but the
session is not broken).

### 2. Install / enable

Install as a pi package (local path for development):

```bash
pi install ../packages/zai-mcp          # user-wide (~/.pi/agent)
pi install -l ../packages/zai-mcp       # project-wide (.pi/settings.json)
```

Or try it without installing:

```bash
pi -e ../packages/zai-mcp
```

> If you're using `bun-apps/s2-agent` (this monorepo's wrapper), none of the above
> is needed — it auto-loads this extension via `bun-apps/s2-agent/run-dir/manifest.json`
> regardless of invocation cwd. See `bun-apps/s2-agent/README.md`.

### 3. Configure (optional)

Environment variables (all optional except `ZAI_API_KEY`):

| Var | Default | Purpose |
|-----|---------|---------|
| `ZAI_API_KEY` | — | Bearer token for all servers (**required** to enable anything) |
| `ZAI_MCP_BASE_URL` | `https://api.z.ai/api/mcp` | Base URL; override for staging / proxies |
| `WEB_SEARCH_ENABLED` | `1` | Set `0` to skip `web-search-prime` |
| `WEB_READER_ENABLED` | `1` | Set `0` to skip `web-reader` |
| `ZREAD_ENABLED` | `1` | Set `0` to skip `zread` |
| `ZAI_MCP_DEBUG_BANNER` | — | Debug: force the startup banner with **no** MCP connection / API key, fired immediately and mirrored to stderr. `=1` → success banner (synthetic tools); `=empty` → no-tools banner. Headless-visible (works in print/RPC where the banner widget is a no-op). |

## How it works

1. On `session_start` the extension lazily connects to each enabled HTTP MCP
   server with `StreamableHTTPClientTransport` (Authorization: Bearer header).
2. It calls `client.listTools()` to discover the server's tools.
3. Each MCP tool is registered as a pi tool via `pi.registerTool()`, prefixed
   with `zai_` to avoid collisions. The MCP JSON Schema is converted to a
   typebox schema.
4. When the LLM calls a tool, the extension forwards the call via
   `client.callTool()` and maps the MCP `content[]` response back to pi's tool
   result format.
5. On `session_shutdown` every transport is closed (no dangling sockets).

## Design notes

- Tool names are namespaced (`zai_<server>_<tool>`) so multiple servers never
  collide.
- Unknown JSON Schema types fall back to `Type.Any()` — registration never fails
  on exotic schemas; the LLM can still pass values through.
- Connection / discovery failures are non-fatal: the affected server is skipped
  and the session continues.

### Graceful degradation (no `ZAI_API_KEY` / connection failures)

All lifecycle/warning logic lives in the `session_start` handler, not the
factory. The factory only receives `ExtensionAPI` (no `ctx`, no `ui`, no
`cwd`), so `ui.notify` / `ui.setStatus` are only reachable inside the handler.
This also matches the pi rule of "don't start long-lived resources in the
factory". Connection happens lazily on `session_start`.

When loaded via `s2-agent` (registered in `bun-apps/s2-agent/run-dir/manifest.json`,
loaded regardless of invocation cwd — see `bun-apps/s2-agent/README.md`), users
**expect it to work** — silence on missing key would be confusing (unlike
opt-in packages such as `ssh`, which can silently no-op). The strategy is a
**single one-shot summary toast**:

- On success, `ctx.ui.notify(...)` fires once at load with a compact list of
  every registered tool (`zai_<server>_<tool>`), so the user can see exactly
  which MCP functions are now available, then it gets out of the way.
- On failure (missing key / network), a `"warning"` toast explains why no
  tools registered.

This deliberately does **not** pin a permanent `setStatus(...)` footer entry —
that would clutter the status line indefinitely for what is really a one-time
load event. The per-tool names embedded in the toast give finer visibility
than an aggregate count would.

**Degradation granularity:** missing key short-circuits **all** HTTP servers
(they share the same bearer token, so retrying per server would just produce 3
identical errors). Per-server `try/catch` still isolates real connection
failures — one server down does not take out the others.

**Cross-mode safety:** `notify` / `setStatus` are no-ops in non-TUI modes
(`json` / `rpc` / `print`) — calling them unconditionally is safe; the agent
never breaks. `throw` in the handler is forbidden (it aborts session load).

## TODO

Non-blocking improvements to handle later:

- [ ] **Retry / backoff on transient connection failures.** Currently each
      server gets a single connection attempt on `session_start`; a flaky
      network permanently disables that server for the session.
- [ ] **Reconnect on network restore.** No watch/retry loop today; a server
      that recovers mid-session stays unregistered.
- [ ] **Surface per-server failures in the load toast.** Today the one-shot
      `notify` lists every registered tool (`zai_<server>_<tool>`); a failed
      server simply contributes no names. Consider appending which server(s)
      failed to connect when some succeed and some don't.
- [ ] **Cache `listTools()` discovery** across sessions within a TTL to shave
      session-start latency.

## Status

- [x] Phase 1 — `web-search-prime` + `web-reader` (HTTP)
- [x] Graceful degradation — one-shot `notify` toast listing registered
      tool names (success) or the reason none registered (disabled / no-tools)
- [ ] Phase 2 — `zread` (HTTP)
- [ ] Phase 3 — `zai-mcp-server` (stdio, with child-process lifecycle)

See `plan/zai-mcp-package.md` for the full design.
