## Task 3: Repo lint — fail on upstream-path leakage (defense in depth)

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts`

**Interfaces:**
- Produces: a `bun test` that runs in the existing `bun run test` matrix
  (`ci.yml:111`) — no CI-wiring change needed. Baselines the one allowed file
  under `docs/superpowers/`.

- [ ] **Step 1: Write the lint test**

Create `tests/artifact-leak.test.ts`:

```ts
/**
 * Repo lint (ADR-0006 defense-in-depth): no superpowers artifact may live under
 * the upstream paths `docs/superpowers/` or `.superpowers/`. Runs in the ext's
 * `bun run test` matrix (ci.yml:111) so leakage fails CI with zero wiring.
 */
import { test, expect } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tests/ → ext pkg → bun-apps → repo root (3 levels up)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Files grandfathered under the upstream paths (the ADR-0006 baseline). */
const ALLOWED = new Set([
  "docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md",
]);

function listFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) listFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

test("no superpowers artifacts leak to upstream paths (ADR-0006)", () => {
  const offenders: string[] = [];
  for (const root of ["docs/superpowers", ".superpowers"]) {
    for (const abs of listFiles(join(repoRoot, root))) {
      const rel = abs.slice(repoRoot.length + 1).replace(/\\/g, "/");
      if (!ALLOWED.has(rel)) offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it passes on the clean tree**

Run: `bun test --cwd bun-apps/pi-agent-ext-superpowers tests/artifact-leak.test.ts`
Expected: PASS (the only file under `docs/superpowers/` is the baseline audit
file; `.superpowers/` is absent).

- [ ] **Step 3: Verify it FAILS on a provoked leak (manual sanity)**

Temporarily create `docs/superpowers/specs/probe.md`, re-run the test, confirm
FAIL, then delete the probe file. (Do not commit the probe.)

```bash
mkdir -p docs/superpowers/specs && echo probe > docs/superpowers/specs/probe.md
bun test --cwd bun-apps/pi-agent-ext-superpowers tests/artifact-leak.test.ts   # expect FAIL
rm -rf docs/superpowers/specs
```

- [ ] **Step 4: Run the full ext suite + lint**

Run: `bun test --cwd bun-apps/pi-agent-ext-superpowers && bun run --cwd bun-apps/pi-agent-ext-superpowers lint`
Expected: all tests PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/tests/artifact-leak.test.ts
git commit -m "test(superpowers): repo lint — fail on upstream-path artifact leakage (ADR-0006)"
```

---

## Self-review

- **Spec coverage:** Destination (no upstream-path writes, ever) → Task 2. No-effort default (auto-dated dir) → Task 2 Step 3 text. Regression guard (text assertion) → Task 2 Step 1; (repo lint) → Task 3. ADR-0006 → Task 1. Acceptance criteria 1–2 → Task 2; 3 → Tasks 2+3; 4 → Task 2 Step 5; 5 → Task 1 Step 3. ✓
- **Placeholder scan:** none — every step has exact paths, code, and commands.
- **Type consistency:** `getBootstrapContent()` (used in Task 2) is the existing exported function; no new symbols introduced.
- **Length invariant:** Task 2 Step 4 explicitly runs the `< 2000` test; Step 3 wording is pre-sized (~+270 net).
