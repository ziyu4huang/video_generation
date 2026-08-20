/**
 * Regression test for the `/goal` TUI status-bar bug.
 *
 * Bug: FooterDataProvider.setExtensionStatus(key, text) mutates the
 * extensionStatuses Map but never notifies anyone (no onExtensionStatusChange),
 * and InteractiveMode.init only subscribes to onBranchChange for re-renders.
 * So the /goal indicator only renders when the footer re-renders for an
 * unrelated reason, and the elapsed time never ticks while idle.
 *
 * Fix: wrapFooterDataProviderForNotify() adds:
 *   - onExtensionStatusChange(cb) → unsubscribe (mirrors onBranchChange)
 *   - notifyExtensionStatusChange()
 *   - setExtensionStatus wrapped: original + notify + requestRender
 *   - clearExtensionStatuses wrapped: original + notify + requestRender
 * And InteractiveMode.prototype.init is patched to apply that wrap.
 */
import { describe, expect, test, mock } from "bun:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
// Importing the patch module applies its import-time side effect (patches
// InteractiveMode.prototype.init). Idempotent — safe to re-import.
import "./footer-extension-status-notify.ts";
import { wrapFooterDataProviderForNotify } from "./footer-extension-status-notify.ts";

/** Minimal FooterDataProvider-shaped mock (no git, no fs watchers). */
function makeMockFdp() {
  const extensionStatuses = new Map<string, string>();
  return {
    extensionStatuses,
    setExtensionStatus(key: string, text: string | undefined) {
      if (text === undefined) extensionStatuses.delete(key);
      else extensionStatuses.set(key, text);
    },
    clearExtensionStatuses() {
      extensionStatuses.clear();
    },
    // Methods that exist on the real class but aren't under test:
    getExtensionStatuses() {
      return extensionStatuses;
    },
    // Stubs for the methods wrapFooterDataProviderForNotify() installs at runtime
    // (overwritten by the wrapper). Declared here so the mock's type admits them
    // and the 7 fdp.onExtensionStatusChange(...) call sites type-check.
    onExtensionStatusChange(_cb: () => void): () => void {
      return () => {};
    },
    notifyExtensionStatusChange() {},
  };
}

describe("wrapFooterDataProviderForNotify", () => {
  test("setExtensionStatus fires onExtensionStatusChange callback + requestRender", () => {
    const fdp = makeMockFdp();
    const render = mock(() => {});
    wrapFooterDataProviderForNotify(fdp, render);

    const notify = mock(() => {});
    fdp.onExtensionStatusChange(notify);

    fdp.setExtensionStatus("goal", "active 5m");
    expect(fdp.extensionStatuses.get("goal")).toBe("active 5m");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
  });

  test("clearExtensionStatuses fires callback + requestRender", () => {
    const fdp = makeMockFdp();
    const render = mock(() => {});
    wrapFooterDataProviderForNotify(fdp, render);
    fdp.setExtensionStatus("goal", "active 5m");

    const notify = mock(() => {});
    fdp.onExtensionStatusChange(notify);

    fdp.clearExtensionStatuses();
    expect(fdp.extensionStatuses.size).toBe(0);
    expect(notify).toHaveBeenCalled();
    expect(render).toHaveBeenCalled();
  });

  test("onExtensionStatusChange returns an unsubscribe that stops further calls", () => {
    const fdp = makeMockFdp();
    const render = mock(() => {});
    wrapFooterDataProviderForNotify(fdp, render);

    const notify = mock(() => {});
    const unsub = fdp.onExtensionStatusChange(notify);

    fdp.setExtensionStatus("goal", "active 1s");
    expect(notify).toHaveBeenCalledTimes(1);

    unsub();
    fdp.setExtensionStatus("goal", "active 2s");
    expect(notify).toHaveBeenCalledTimes(1); // not called again
  });

  test("setExtensionStatus(undefined) (delete) still notifies", () => {
    const fdp = makeMockFdp();
    const render = mock(() => {});
    wrapFooterDataProviderForNotify(fdp, render);
    fdp.setExtensionStatus("goal", "active 1s");

    const notify = mock(() => {});
    fdp.onExtensionStatusChange(notify);

    fdp.setExtensionStatus("goal", undefined);
    expect(fdp.extensionStatuses.has("goal")).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("idempotent: double-wrapping does not stack notify/render calls", () => {
    const fdp = makeMockFdp();
    const render = mock(() => {});
    wrapFooterDataProviderForNotify(fdp, render);
    wrapFooterDataProviderForNotify(fdp, render); // no-op

    fdp.setExtensionStatus("goal", "active 1s");
    // If double-wrapped, render would fire 2x (once per wrapper layer).
    expect(render).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe restores original methods", () => {
    const fdp = makeMockFdp();
    const render = mock(() => {});
    const restore = wrapFooterDataProviderForNotify(fdp, render);

    restore();
    fdp.setExtensionStatus("goal", "active 1s");
    expect(render).not.toHaveBeenCalled();
    expect(fdp.onExtensionStatusChange).toBeUndefined();
  });

  test("mutiple subscribers all fire", () => {
    const fdp = makeMockFdp();
    const render = mock(() => {});
    wrapFooterDataProviderForNotify(fdp, render);

    const a = mock(() => {});
    const b = mock(() => {});
    fdp.onExtensionStatusChange(a);
    fdp.onExtensionStatusChange(b);

    fdp.setExtensionStatus("goal", "active 1s");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("InteractiveMode.prototype.init patch", () => {
  test("InteractiveMode.prototype.init is a function (patch did not clobber it)", () => {
    expect(typeof InteractiveMode.prototype.init).toBe("function");
  });

  test("patch is idempotent (apply twice → false the second time)", async () => {
    // The import already applied it once. Re-applying must be a no-op.
    const { applyFooterExtensionStatusNotifyPatch } = await import(
      "./footer-extension-status-notify.ts"
    );
    expect(applyFooterExtensionStatusNotifyPatch()).toBe(false);
  });
});
