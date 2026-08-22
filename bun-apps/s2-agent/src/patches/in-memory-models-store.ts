/**
 * in-memory-models-store — wraps ModelRuntime.create() so every runtime the
 * SDK constructs uses an InMemoryModelsStore unless the caller explicitly
 * passed one.
 *
 * WHY
 * ---
 * pi's ModelRuntime.create() defaults to a FileModelsStore rooted at
 * ~/.pi/agent/models-store.json (model-runtime.js:
 * `modelsStorePath ?? join(dirname(modelsPath), "models-store.json")`), and
 * pi-ai's catalog refresh PERSISTS refreshed provider catalogs to that store
 * (models.js: `await this.modelsStore.write(providerId, publication.persist)`).
 * The repo deliberately does not want that file:
 *
 *   1. pi 0.84.2's builtin catalog (pi-ai dist/models.generated.js MODELS)
 *      already ships zai (glm-4.7/5-turbo/5.2/5.2-highspeed/5.3), deepseek
 *      and huggingface — the curated seed added nothing the builtin catalog
 *      lacks, so the retired ensure-models-store seed (removed 2026-08-22)
 *      and this file were pure duplication.
 *   2. Cross-session catalog caching buys nothing here: pi's own main() boots
 *      with allowModelNetwork:false, and on-demand refresh (the TUI /model
 *      selector) re-fetches per session anyway.
 *
 * Injecting the in-memory store makes the binary's model-catalog surface
 * fully self-contained: no ~/.pi/agent/models-store.json is ever created,
 * seeded, or written — by us or by pi.
 *
 * HOW
 * ---
 * Same wrap shape as ./pre-load-providers.ts: capture the real static
 * factory, re-assign a wrapper that fills `options.modelsStore` ONLY when the
 * caller omitted it (an explicit caller choice always wins — flux2's vlm.ts
 * passes modelsPath:null and already lands on an in-memory store either way).
 * Callers covered: pi main()/--list-models, the SDK entry, core-runtime's
 * agent.ts/available-models.ts, the package-manager CLI.
 *
 * Side-effecting — only ever imported from applyPatches() (./index.ts),
 * gated by BUN_PI_IN_MEMORY_MODELS_STORE (=0 disables).
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";

// Capture the real factory before any other patch can touch it.
type CreateFn = typeof ModelRuntime.create;
const _realCreate: CreateFn = ModelRuntime.create;

/**
 * Pure wrap: return a create() that fills `options.modelsStore` with an
 * InMemoryModelsStore ONLY when the caller omitted one (??= semantics — an
 * explicit modelsStore/modelsStorePath always wins). Exported so the wrap
 * behavior is unit-testable without a real ModelRuntime (module-cache order
 * makes re-importing the patch against a fresh fake unreliable under
 * `bun test`'s shared registry — see the test file header).
 */
export function wrapCreateWithInMemoryStore(real: CreateFn): CreateFn {
  return (async (options = {}) => {
    options.modelsStore ??= new InMemoryModelsStore();
    return real(options);
  }) as CreateFn;
}

// Same hookability guard as ./pre-load-providers.ts: assigning over an
// undefined factory would install a wrap that nothing can call, and every
// static check would stay green while the first create() crashed.
const hookable = typeof _realCreate === "function";

if (hookable) {
  ModelRuntime.create = wrapCreateWithInMemoryStore(_realCreate);
}

/**
 * Whether the wrap actually bound. `applyPatches()` reads this and reports a
 * false as a patch failure instead of claiming success.
 */
export const patchApplied = hookable;
