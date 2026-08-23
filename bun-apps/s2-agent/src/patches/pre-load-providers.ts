/**
 * patches/pre-load-providers — wraps ModelRuntime.create() to register
 * s2-agent's baked PROVIDERS catalog onto every runtime the SDK constructs.
 *
 * HOW IT WORKS
 * ------------
 * pi's SDK (>=0.80) builds every ModelRuntime via the async static factory
 * `ModelRuntime.create()` — used by main()/--list-models, the SDK entry, and
 * the package-manager CLI alike (all three ModelRuntime construction sites go
 * through it). We wrap that factory so the freshly-built runtime gets every
 * PROVIDERS entry registered through its real `registerProvider()` before it
 * is handed back to the caller. registerProvider() stores the config in the
 * runtime's extensionProviders map, recomposes the provider, and updates the
 * model snapshot synchronously — so the baked providers appear in
 * getAvailable() / --list-models immediately, with NO ~/.pi/agent/models.json
 * required.
 *
 * HISTORY
 * -------
 * Before the 0.80 SDK refactor this patch hooked
 * `ModelRegistry.prototype.loadModels`, which the (old, stateful) registry's
 * constructor used to call. That method no longer exists: ModelRegistry is now
 * a stateless facade delegating to ModelRuntime, and has no loadModels() at
 * all. The old hook therefore silently no-op'd — it installed a method that
 * nothing ever invoked, so registerAllProviders never ran and the baked
 * providers were only ever visible because ~/.pi/agent/models.json happened to
 * duplicate them. Hooking create() fixes that.
 *
 * Side-effecting — only ever imported from applyPatches() (./index.ts), gated
 * by BUN_PI_PRE_LOAD_PROVIDERS. Never import this from the library barrel
 * (../index.ts) or anywhere PROVIDERS/resolveApiKey/registerAllProviders alone
 * would suffice — see ../pre-load-providers.ts's header for why.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { publishSeam } from "@repo/s2-agent-core-interface";
import { EMBEDDING_CONFIG, registerAllProviders } from "../pre-load-providers.ts";

// Also publish the baked embedding endpoint+model (kcard-parity D8, ticket 01)
// on the __piEmbeddingConfig seam. This patch is the host's sanctioned
// startup side-effect site; the EMBEDDING_CONFIG module stays side-effect-free
// by design. One env gate for both: disabling BUN_PI_PRE_LOAD_PROVIDERS drops
// the host-baked provider catalog AND the embedding seam, and
// embedding-leaf.ts falls through to env → built-in defaults. Unconditional
// (globalThis assignment cannot fail) — no patchApplied claim needed.
publishSeam("__piEmbeddingConfig", { base: EMBEDDING_CONFIG.base, model: EMBEDDING_CONFIG.model });

// Capture the real factory before any other patch can touch it.
type CreateFn = typeof ModelRuntime.create;
const _realCreate: CreateFn = ModelRuntime.create;

// Verify the hook target EXISTS before wrapping it. This is the precise shape
// of the historical failure documented above: `ModelRegistry.prototype.loadModels`
// disappeared upstream, the assignment still succeeded, nothing threw, and the
// patch installed a method nobody called. Assigning over an undefined
// `ModelRuntime.create` would repeat it exactly — the wrapper would be
// installed, `_realCreate(...)` would throw only on first use, and every static
// check would stay green.
const hookable = typeof _realCreate === "function";

if (hookable) {
  ModelRuntime.create = (async (options = {}) => {
    const runtime = await _realCreate(options);
    // registerProvider recomposes + updates the snapshot synchronously, so the
    // baked providers are visible before the caller ever reads
    // getAvailable()/getModel(). A literal-string apiKey marks the provider
    // configured (configuredRequestAuthStatus → "fallback"), so it shows up in
    // snapshot.available / --list-models with no stored credential needed.
    registerAllProviders(runtime);
    return runtime;
  }) as CreateFn;
}

/**
 * Whether the wrap actually bound. `applyPatches()` reads this and reports a
 * false as a patch failure instead of claiming success — see ./index.ts.
 */
export const patchApplied = hookable;
