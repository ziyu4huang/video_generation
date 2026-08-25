/**
 * load-run-dir-resources — splices this repo's fixed extension/skill set into
 * argv as absolute -e/--skill paths, resolved from run-dir/ (see
 * src/run-dir/resolve.ts), before main() reads process.argv.
 *
 * WHY: pi's main() threads a single process.cwd() into every project-resource
 * lookup (.pi/settings.json, .pi/extensions, ...) with no --cwd override. That
 * means the old .pi/settings.json "packages" list only worked when invoked
 * with cwd === this repo's root. Absolute -e/--skill paths bypass cwd
 * resolution and trust-gating entirely, so this patch makes extension loading
 * work regardless of where s2-agent is invoked from.
 */
import { resolveRunDirArgv } from "../run-dir/resolve.ts";
import { userSuppressFlags } from "../cli-argv.ts";

// process.argv is still the UNSPLICED user argv at this point (this patch is
// what does the splicing), so the flags read here are exactly what the user
// typed — the deploy modes' self-injected "-ne" hasn't been added yet.
const userFlags = userSuppressFlags(process.argv.slice(2));
const extra = await resolveRunDirArgv(userFlags);

if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
  console.error("[bun-pi] run-dir resolved argv:", extra);
}

process.argv.splice(2, 0, ...extra);

// (`-e <alias>` lazy rewriting used to run here — deleted 2026-08-25 round-2
// ticket 11: the alias registry had been empty since ultracode went eager.
// The user's own `-e <file>` values were never touched and still pass through
// to the SDK untouched.)
