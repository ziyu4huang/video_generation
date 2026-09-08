/**
 * svg-liveness.test.ts — the render seam's liveness fuse (effort
 * 2026-09-09-file2md-render-hardening, ticket 02).
 *
 * svg-lane.test.ts mocks this module; here the REAL rasterizer runs against
 * injected fake views: a stalled WebView (never-resolving navigate/evaluate/
 * screenshot — the "never-composited window" the reviewer flagged) must hit
 * the liveness fuse and degrade to null quickly, with the view still closed;
 * a healthy fake proves the DI seam carries a real capture end to end.
 * No test touches a real Bun.WebView.
 */
import { describe, expect, test } from "bun:test";
import { renderSvgFileToPng, renderSvgTextToPng, SVG_LIVENESS_MS } from "../src/raster/svg.ts";

class FakeWebView {
  static healthy = true;
  closed = false;
  navigate(): Promise<void> {
    return FakeWebView.healthy ? Promise.resolve() : new Promise(() => {});
  }
  evaluate(): Promise<string> {
    if (!FakeWebView.healthy) return new Promise(() => {});
    // Measure pass reports a 100×50 element; ready pass returns 'ok'.
    return Promise.resolve(JSON.stringify({ w: 100, h: 50 }));
  }
  async screenshot(): Promise<Blob> {
    if (FakeWebView.healthy) return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])]);
    return new Promise(() => {});
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeFactory(): (w: number, h: number) => Bun.WebView {
  const views: FakeWebView[] = [];
  const factory = (() => {
    const v = new FakeWebView();
    views.push(v);
    return v as unknown as Bun.WebView;
  }) as (w: number, h: number) => Bun.WebView;
  (factory as unknown as { views: FakeWebView[] }).views = views;
  return factory;
}

describe("liveness fuse", () => {
  test("SVG_LIVENESS_MS default is 10s", () => {
    expect(SVG_LIVENESS_MS).toBe(10_000);
  });

  test("stalled probe pass degrades to null within the budget, view closed", async () => {
    FakeWebView.healthy = false;
    const factory = fakeFactory();
    const t0 = Date.now();
    const r = await renderSvgTextToPng("<svg width='10' height='10'><rect/></svg>", {
      createView: factory,
      livenessMs: 120,
    });
    const elapsed = Date.now() - t0;
    expect(r).toBeNull();
    expect(elapsed).toBeLessThan(5_000); // the fuse fired, not a hang
    const views = (factory as unknown as { views: FakeWebView[] }).views;
    expect(views.length).toBe(1);
    expect(views[0]!.closed).toBe(true);
  });

  test("stalled capture pass (healthy probe, stalled shot) degrades too", async () => {
    // Healthy until the measure succeeds, then stall the second view.
    let calls = 0;
    const factory = (() => {
      calls++;
      const v = calls === 1 ? new FakeWebView() : new StalledSecond();
      return v as unknown as Bun.WebView;
    }) as (w: number, h: number) => Bun.WebView;
    class StalledSecond extends FakeWebView {
      navigate(): Promise<void> {
        return new Promise(() => {});
      }
      evaluate(): Promise<string> {
        return new Promise(() => {});
      }
      override async screenshot(): Promise<Blob> {
        return new Promise(() => {});
      }
    }
    FakeWebView.healthy = true;
    const r = await renderSvgFileToPng("/tmp/file2md-smoke.svg", {
      createView: factory,
      livenessMs: 120,
    });
    expect(r).toBeNull();
  });

  test("healthy fake view flows a full capture through the DI seam", async () => {
    FakeWebView.healthy = true;
    const factory = fakeFactory();
    const r = await renderSvgTextToPng("<svg width='100' height='50'><rect/></svg>", {
      createView: factory,
      livenessMs: 2_000,
    });
    expect(r).not.toBeNull();
    expect(r!.width).toBe(100);
    expect(r!.height).toBe(50);
    expect(r!.png.byteLength).toBeGreaterThan(0);
    const views = (factory as unknown as { views: FakeWebView[] }).views;
    expect(views.length).toBe(2); // probe + capture
    for (const v of views) expect(v.closed).toBe(true);
  });
});
