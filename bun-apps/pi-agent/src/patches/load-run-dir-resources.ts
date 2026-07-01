/**
 * load-run-dir-resources — splices this repo's fixed extension/skill set into
 * argv as absolute -e/--skill paths, resolved from run-dir/ (see
 * run-dir/resolve.ts), before main() reads process.argv.
 *
 * WHY: pi's main() threads a single process.cwd() into every project-resource
 * lookup (.pi/settings.json, .pi/extensions, ...) with no --cwd override. That
 * means the old .pi/settings.json "packages" list only worked when invoked
 * with cwd === this repo's root. Absolute -e/--skill paths bypass cwd
 * resolution and trust-gating entirely, so this patch makes extension loading
 * work regardless of where pi-agent is invoked from.
 */
import { resolveRunDirArgv } from "../../run-dir/resolve.ts";

const extra = await resolveRunDirArgv();

if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
  console.error("[bun-pi] run-dir resolved argv:", extra);
}

process.argv.splice(2, 0, ...extra);
