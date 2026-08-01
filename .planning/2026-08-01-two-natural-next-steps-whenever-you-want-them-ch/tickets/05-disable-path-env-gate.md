type: research

## Question

Is the disable-path `BUN_PI_FORCE_RESPONSE_LANGUAGE=0` actually a **clean
no-op** (no block injected), and is it **tested**?

**Context (chart-time):**
- `PATCH_TABLE` entry:
  `{ name: "force-response-language", env: "BUN_PI_FORCE_RESPONSE_LANGUAGE", defaultValue: true }`.
- `resolvePatchPlan` gates the import — when the env is `0`, the patch file is
  never imported, so the prototype wrap never applies.
- The GENERAL env-gate mechanism is likely tested (resolvePatchPlan tests), but
  is there a test asserting THIS patch specifically no-ops when disabled (no
  forced block in any prompt)?

Resolve by:
1. Confirming `resolvePatchPlan` skips the import on `env=0` for this entry.
2. Checking whether any test asserts the disabled-state no-op for this patch.
3. Noting the fallback semantics — does `=0` differ from *unset*? From `=false`?

**Outcome:** "tested + clean (closed)" or "untested → graduate a regression-test
task ticket (assert no forced block when disabled)."
