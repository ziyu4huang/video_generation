# s2-agent-ext-zai-mcp

The ubiquitous language of s2-agent-ext-zai-mcp — Z.ai MCP servers bridged into pi. pi has no built-in MCP integration, so this extension is an MCP client that re-registers each tool from the configured Z.ai servers as a normal pi tool the LLM can call directly. Standard MCP terms (client, server, transport) are assumed, not redefined here.

## Language

### The bridge

**Bridge**:
The extension's role — pi has no native MCP integration, so zai-mcp bridges MCP servers into pi tools.
_Avoid_: adapter, connector (it is the pi↔MCP bridge specifically)

**Re-registration**:
Each MCP tool discovered via `client.listTools()` is registered as a pi tool via `pi.registerTool()`, its JSON Schema converted to typebox. The core action of the bridge.
_Avoid_: mapping, proxying (it is MCP-tool → pi-tool registration)

**Namespace prefix** (`zai_<server>_<tool>`):
Every re-registered tool is prefixed so multiple servers never collide (e.g. `zai_web-search-prime_*`).
_Avoid_: tool prefix, naming (it is the collision-avoidance prefix)

### Servers

**Z.ai MCP servers**:
The configured servers — `web-search-prime` (search), `web-reader` (fetch/read), `zread` (read & parse), and the stdio `zai-mcp-server` (phase 3). All authenticate with one shared bearer token.
_Avoid_: endpoints, APIs (they are MCP servers, not REST endpoints)

**Shared bearer token** (`ZAI_API_KEY`):
One bearer token authenticates all servers; missing it short-circuits every HTTP server (they share the token, so per-server retry would just repeat the same error).
_Avoid_: API key per server (it is one shared token)

### Lifecycle

**Lazy connect** (`session_start`):
Connection + `listTools()` discovery happens lazily on `session_start`, not in the factory (which has no `ctx`/`ui`/`cwd` and shouldn't start long-lived resources).
_Avoid_: init, startup (it is deferred-to-session_start connection)

**Graceful degradation**:
A missing key or connection failure is non-fatal — the affected server is skipped and the session continues. Missing key short-circuits all HTTP servers; per-server try/catch isolates real connection failures (one server down doesn't take out the others).
_Avoid_: error handling, fallback (it is non-fatal skip-and-continue)

**One-shot summary toast**:
A single `ui.notify` at load — lists every registered tool on success (so the user sees exactly which MCP functions are available) or the reason none registered on failure. Deliberately not a permanent status-bar entry.
_Avoid_: status indicator, notification (it is a one-time load toast)
