/**
 * pre-load-providers-patch — monkey-patches ModelRegistry.prototype.loadModels
 * to register pi-agent's baked PROVIDERS catalog.
 *
 * HOW IT WORKS
 * ------------
 * ModelRegistry's constructor calls the private loadModels(), not refresh().
 * We wrap loadModels() so that after the built-in catalog loads, we call the
 * real registerProvider() for every PROVIDERS entry (via registerAllProviders,
 * shared with pi-agent-cli). registerProvider() stores the config in
 * registeredProviders, so any later refresh() replays it automatically.
 *
 * Side-effecting — only ever imported from applyPatches() (./index.ts), gated
 * by BUN_PI_PRE_LOAD_PROVIDERS. Never import this from the library barrel
 * (../index.ts) or anywhere PROVIDERS/resolveApiKey/registerAllProviders alone
 * would suffice — see ../pre-load-providers.ts's header for why.
 */
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { registerAllProviders } from "../pre-load-providers.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Proto = ModelRegistry.prototype as any;

// Capture the real method before any other patch can touch it.
const _realLoadModels = Proto.loadModels as (this: unknown) => void;
const _realRegisterProvider = Proto.registerProvider as (
  this: unknown,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
Proto.loadModels = function (this: any) {
  _realLoadModels.call(this);
  registerAllProviders({
    registerProvider: (name, config) => _realRegisterProvider.call(this, name, config),
  });
};

export const preLoadProvidersPatchApplied = true;
