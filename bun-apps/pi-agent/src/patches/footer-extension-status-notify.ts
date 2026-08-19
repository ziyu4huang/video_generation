/**
 * footer-extension-status-notify — make extension status changes (the `/goal`
 * indicator) re-render the footer live.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * `FooterDataProvider.setExtensionStatus(key, text)` mutates the
 * `extensionStatuses` Map but does NOT notify any subscriber — unlike
 * `setGitBranch`, which (via `notifyBranchChange()`) is subscribed in
 * `InteractiveMode.init` → `this.ui.requestRender()`. There is no
 * `onExtensionStatusChange` counterpart. As a result, extension statuses only
 * appear when the footer re-renders for an unrelated reason (a git-branch
 * change or agent message activity), and the `/goal` elapsed time never ticks
 * while the agent is idle — the exact symptom: "I can't see the goal is working
 * or not, not elapsed time."
 *
 * FIX
 * ---
 * `FooterDataProvider` is NOT exported from the SDK (the package `exports`
 * field blocks internal imports), so we cannot import + monkey-patch its
 * prototype directly. Instead we patch the exported `InteractiveMode` (which
 * owns the `footerDataProvider` instance) to wrap that instance in `init()`,
 * right after the existing `onBranchChange` subscription is wired:
 *
 *   - `onExtensionStatusChange(cb)`: subscribe → returns unsubscribe
 *     (mirrors `onBranchChange`).
 *   - `notifyExtensionStatusChange()`: fire all callbacks.
 *   - `setExtensionStatus(key, text)` wrapped: original + notify + requestRender.
 *   - `clearExtensionStatuses()` wrapped: original + notify + requestRender.
 *
 * The core wiring is extracted into `wrapFooterDataProviderForNotify()` so the
 * notify/render behavior is unit-testable without constructing a heavy
 * InteractiveMode instance.
 *
 * Env gate: BUN_PI_FOOTER_EXT_STATUS_NOTIFY (default on). Reversible.
 *
 * NOTE: This makes the indicator *appear* on change. As of 2026-07-06 this patch
 * is REDUNDANT in SDK 0.80.3 (InteractiveMode.setExtensionStatus already calls
 * ui.requestRender()) and its original consumer moved off ctx.ui.setStatus to a
 * setWidget overlay (PR #324). Retained for the public setStatus API + this
 * repo's opt-OFF-not-opt-IN patch invariant. See patches/index.ts for the full
 * rationale. The 1s heartbeat this NOTE used to reference was removed with the
 * goal setStatus path.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFooterData = any;

/**
 * Wrap a FooterDataProvider-like instance so extension status changes notify
 * subscribers AND trigger a footer re-render.
 *
 * Idempotent: re-wrapping a wrapped instance is a no-op (returns a no-op
 * unsubscribe) so multiple `init()` calls (e.g. session rebind) don't stack
 * wrappers.
 *
 * @param fdp FooterDataProvider instance (owns setExtensionStatus, clearExtensionStatuses)
 * @param requestRender called after each mutation to trigger a footer re-render
 * @returns unsubscribe that restores the original methods (for tests / teardown)
 */
export function wrapFooterDataProviderForNotify(
  fdp: AnyFooterData,
  requestRender: () => void,
): () => void {
  // Idempotency guard: never double-wrap.
  if (fdp.__extensionStatusNotifyWrapped) return () => {};

  const callbacks = new Set<() => void>();
  const origSet = fdp.setExtensionStatus.bind(fdp);
  const origClear = fdp.clearExtensionStatuses.bind(fdp);

  /** Subscribe to extension-status changes. Returns an unsubscribe. */
  fdp.onExtensionStatusChange = (cb: () => void) => {
    callbacks.add(cb);
    return () => callbacks.delete(cb);
  };

  /** Internal: fire all extension-status-change callbacks. */
  fdp.notifyExtensionStatusChange = () => {
    for (const cb of callbacks) cb();
  };

  fdp.setExtensionStatus = (key: string, text: string | undefined) => {
    origSet(key, text);
    fdp.notifyExtensionStatusChange();
    requestRender();
  };

  fdp.clearExtensionStatuses = () => {
    origClear();
    fdp.notifyExtensionStatusChange();
    requestRender();
  };

  fdp.__extensionStatusNotifyWrapped = true;

  return () => {
    fdp.setExtensionStatus = origSet;
    fdp.clearExtensionStatuses = origClear;
    delete fdp.onExtensionStatusChange;
    delete fdp.notifyExtensionStatusChange;
    delete fdp.__extensionStatusNotifyWrapped;
    callbacks.clear();
  };
}

// ── Module-scoped flag: apply once ──────────────────────────────────────────
let applied = false;

/**
 * Patch InteractiveMode.prototype.init so that after the SDK wires its
 * `onBranchChange` subscription, we also wrap the footerDataProvider with the
 * extension-status notify/render behavior.
 *
 * Returns true if applied, false if already applied or the init method is
 * missing (e.g. SDK upgrade changed the shape).
 */
export function applyFooterExtensionStatusNotifyPatch(): boolean {
  if (applied) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = InteractiveMode.prototype as any;
  const originalInit = proto.init as (() => Promise<void>) | undefined;
  if (!originalInit || typeof originalInit !== "function") return false;

  proto.init = async function (this: {
    footerDataProvider?: AnyFooterData;
    ui: { requestRender: () => void };
  }) {
    await originalInit.call(this);
    // After init wires onBranchChange, also wire extension-status notify.
    // The footerDataProvider is created in the constructor, so it exists here.
    if (this.footerDataProvider) {
      wrapFooterDataProviderForNotify(this.footerDataProvider, () => this.ui.requestRender());
    }
  } as () => Promise<void>;

  applied = true;
  return true;
}

// ── Import-time side effect ──────────────────────────────────────────────────
const debug =
  process.env.BUN_PI_DEBUG_PATCHES === "1" || process.env.BUN_PI_DEBUG_PATCHES === "true";
const enabled = process.env.BUN_PI_FOOTER_EXT_STATUS_NOTIFY !== "0";
let outcome = false;
if (enabled) {
  const ok = applyFooterExtensionStatusNotifyPatch();
  outcome = ok;
  if (debug) {
    console.error(
      `[bun-pi] footer-extension-status-notify: ${ok ? "applied" : "already applied or failed"}`,
    );
  }
}

/**
 * Whether the wrap actually bound. `applyPatches()` reads this and reports a
 * false as a patch failure instead of claiming success — see ./index.ts.
 * `enabled === false` (env opt-out) is reported as applied: the patch did
 * exactly what it was asked to do.
 */
export const patchApplied = enabled ? outcome : true;
