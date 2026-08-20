/**
 * Fixture for pre-load-providers.test.ts's side-effect regression test. Runs in
 * its own subprocess (fresh module cache) so no other test file's import of the
 * patch module can taint the result. Imports ONLY ../../pre-load-providers.ts,
 * then reports whether ModelRuntime.create was touched.
 *
 * (This is the "importing the pure catalog must not install the monkey-patch"
 * guard. The patch wraps ModelRuntime.create; the catalog module must leave it
 * alone so s2-agent-cli can import PROVIDERS without double-registering.)
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const before = ModelRuntime.create;
await import("../../pre-load-providers.ts");
const after = ModelRuntime.create;

console.log(JSON.stringify({ unchanged: after === before }));
