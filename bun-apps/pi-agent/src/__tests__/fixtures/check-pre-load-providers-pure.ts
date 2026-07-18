/**
 * Fixture for pre-load-providers.test.ts's side-effect regression test. Runs in
 * its own subprocess (fresh module cache) so no other test file's import of the
 * patch module can taint the result. Imports ONLY ../../pre-load-providers.ts,
 * then reports whether ModelRegistry.prototype.loadModels was touched.
 */
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const before = (ModelRegistry.prototype as any).loadModels;
await import("../../pre-load-providers.ts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const after = (ModelRegistry.prototype as any).loadModels;

console.log(JSON.stringify({ unchanged: after === before }));
