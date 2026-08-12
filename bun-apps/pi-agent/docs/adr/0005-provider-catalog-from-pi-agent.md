> **Amended 2026-08-12 (pi-agent-cli merge).** The CLI now lives inside `pi-agent`
> (`src/cli/`), so the catalog is reached by a relative import
> (`src/cli/sessions/shared.ts` → `../../pre-load-providers.ts`) instead of the
> `@repo/pi-agent` workspace dependency. The invariant is unchanged and now
> structurally enforced: there is exactly one `PROVIDERS` catalog, in one package.

# Provider catalog sourced from @repo/pi-agent, not duplicated or models.json-only

pi-agent-cli does not define its own provider/model catalog, nor does it rely
solely on ~/.pi/agent/models.json. It imports `PROVIDERS` (and `resolveApiKey`)
from the sibling `@repo/pi-agent` package and registers each entry explicitly in
`buildBakedRegistry()`, unconditionally overwriting any same-named global entry.
The baked entries carry a zero-cost policy — they target local-server providers
(LM Studio today), which have no billing. Adding or changing a baked model is a
one-file edit in `pi-agent`'s `PROVIDERS`, and both CLIs pick it up — there is no
second catalog to drift. The global models.json is still honored (layered under
the baked entries, and the only source for providers NOT in `PROVIDERS`), so
users can configure other providers there without touching code;
`PI_SKIP_MODELS_JSON=1` yields a fully hermetic in-memory registry (baked
providers only) for the compiled binary. The trade-off: pi-agent-cli takes a
workspace dependency on a sibling *tool* package (pi-agent, the interactive TUI)
for its catalog — which reads as circular until you see that pi-agent is also a
library exporting `PROVIDERS`, and that sharing the catalog is the point (one
definition, two entry points). The alternative — duplicating the catalog in
pi-agent-cli — would guarantee drift the first time someone adds a model to one
and not the other.
