**ID:** `ADR-s2-agent-0005` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

> **Amended 2026-08-12 (s2-agent-cli merge).** The CLI now lives inside `s2-agent`
> (`src/cli/`), so the catalog is reached by a relative import
> (`src/cli/sessions/shared.ts` → `../../pre-load-providers.ts`) instead of the
> `@repo/s2-agent` workspace dependency. The invariant is unchanged and now
> structurally enforced: there is exactly one `PROVIDERS` catalog, in one package.

# Provider catalog sourced from @repo/s2-agent, not duplicated or models.json-only

s2-agent-cli does not define its own provider/model catalog, nor does it rely
solely on ~/.pi/agent/models.json. It imports `PROVIDERS` (and `resolveApiKey`)
from the sibling `@repo/s2-agent` package and registers each entry explicitly in
`buildBakedRegistry()`, unconditionally overwriting any same-named global entry.
The baked entries carry a zero-cost policy — they target local-server providers
(LM Studio today), which have no billing. Adding or changing a baked model is a
one-file edit in `s2-agent`'s `PROVIDERS`, and both CLIs pick it up — there is no
second catalog to drift. The global models.json is still honored (layered under
the baked entries, and the only source for providers NOT in `PROVIDERS`), so
users can configure other providers there without touching code;
`PI_SKIP_MODELS_JSON=1` yields a fully hermetic in-memory registry (baked
providers only) for the compiled binary. The trade-off: s2-agent-cli takes a
workspace dependency on a sibling *tool* package (s2-agent, the interactive TUI)
for its catalog — which reads as circular until you see that s2-agent is also a
library exporting `PROVIDERS`, and that sharing the catalog is the point (one
definition, two entry points). The alternative — duplicating the catalog in
s2-agent-cli — would guarantee drift the first time someone adds a model to one
and not the other.
