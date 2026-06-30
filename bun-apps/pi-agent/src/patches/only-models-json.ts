/**
 * bun-pi — custom-models patch.
 *
 * Merges `~/.pi/agent/models.json` with the stock built-in provider catalog by:
 *
 *   1. Keeping built-in models (zai, deepseek, huggingface, …) intact.
 *   2. Adding custom providers/models from models.json on top (lm-studio, etc.).
 *   3. Ignoring provider registrations from project-local `.pi/` extensions
 *      (`registerProvider` becomes a no-op) to keep the list predictable.
 *
 * Net effect: every model from the built-in catalog AND every entry in
 * models.json is available; project-local extension providers are suppressed.
 *
 * Reliability: `main()` and this module import the *same* `ModelRegistry`
 * class object (shared Bun module cache), so patching the prototype here
 * affects the instance `main()` constructs internally. No fork, no rewrite.
 */
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Proto = ModelRegistry.prototype as any;

/** Ignore provider registrations from project-local extensions. */
Proto.registerProvider = function (): void {
  /* no-op: prevent project-local .pi/ extensions from injecting providers */
};

export const onlyModelsJsonApplied = true;
