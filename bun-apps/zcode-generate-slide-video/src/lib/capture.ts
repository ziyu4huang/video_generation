import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic animated capture via the Chrome DevTools Protocol:
 * launch headless Chrome with a debug port, connect to the PAGE target's own
 * WebSocket (no session routing), wait for the injected __zbSeek to exist,
 * then for each capture timestamp: evaluate __zbSeek(t) → screenshot.
 * Timing is exact (frames are a pure function of t), independent of the
 * browser's frame clock — headless screencasts stall at ~3 frames on this
 * Chrome build, so we drive frames ourselves.
 */

function launchDebuggingChrome(
  chrome: string,
  profileDir: string,
  size: { width: number; height: number },
): Promise<{ httpBase: string; child: ReturnType<typeof spawn> }> {
  const child = spawn(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      `--window-size=${size.width},${size.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("chrome did not report a DevTools port in 20s")), 20_000);
    child.stderr!.on("data", (c: string) => {
      buffer += c;
      const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        const u = new URL(m[1]!);
        resolve({ httpBase: `http://${u.hostname}:${u.port}`, child });
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`chrome exited ${code} before DevTools was ready`));
    });
  });
}

export interface CaptureOptions {
  /** Total seconds to cover (segment duration). */
  durationSec: number;
  width: number;
  height: number;
  chrome: string;
  /** Fresh profile dir for this one capture (single chrome launch). */
  profileDir: string;
  /** Screenshot interval during the build phase, seconds. */
  buildStepSec?: number;
  /** Screenshot interval after the build completes, seconds. */
  holdStepSec?: number;
}

/**
 * Capture `url` at deterministic timestamps. Writes frame-%04d.png into
 * outDir; returns the frame times (ms since capture t=0, i.e. segment time).
 */
export async function captureAnimated(
  url: string,
  outDir: string,
  opts: CaptureOptions,
): Promise<{ count: number; times: number[] }> {
  const buildStep = (opts.buildStepSec ?? 0.25) * 1000;
  const holdStep = (opts.holdStepSec ?? 1.0) * 1000;
  mkdirSync(outDir, { recursive: true });
  mkdirSync(opts.profileDir, { recursive: true });
  const { httpBase, child } = await launchDebuggingChrome(opts.chrome, opts.profileDir, {
    width: opts.width,
    height: opts.height,
  });

  let frameCount = 0;
  const frameTimes: number[] = [];
  try {
    const pageWs: string = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no page target appeared in 15s")), 15_000);
      const poll = async (): Promise<boolean> => {
        try {
          const targets = (await (await fetch(`${httpBase}/json`)).json()) as {
            type: string;
            webSocketDebuggerUrl?: string;
          }[];
          // headless about:blank may report type "other"; prefer a real page.
          const page =
            targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ??
            targets.find((t) => t.webSocketDebuggerUrl && t.type !== "service_worker" && t.type !== "node");
          if (page) {
            clearTimeout(timer);
            resolve(page.webSocketDebuggerUrl!);
            return true;
          }
        } catch { /* chrome not accepting yet */ }
        return false;
      };
      void poll();
      const interval = setInterval(async () => {
        if (await poll()) clearInterval(interval);
      }, 300);
    });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(pageWs);
      let msgId = 0;
      const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
        new Promise((resolve, reject) => {
          const id = ++msgId;
          pending.set(id, { resolve, reject });
          try {
            ws.send(JSON.stringify({ id, method, params }));
          } catch (e) {
            pending.delete(id);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });

      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as {
          id?: number;
          result?: any;
          error?: { message: string };
        };
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (p) (msg.error ? p.reject(new Error(`${msg.error.message}`)) : p.resolve(msg.result));
        }
      };
      ws.onerror = () => reject(new Error("CDP websocket error"));
      ws.onclose = () => { /* resolved by then */ };

      ws.onopen = async () => {
        try {
          await send("Page.enable");
          // Pin the viewport exactly — screenshot size follows it, and x264
          // needs even dimensions (1920×1080 here).
          await send("Emulation.setDeviceMetricsOverride", {
            width: opts.width,
            height: opts.height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await send("Page.navigate", { url });
          // Wait for the injected schedule (load + viewer init) to exist.
          const deadline = Date.now() + 30_000;
          let buildMs = 0;
          for (;;) {
            if (Date.now() > deadline) throw new Error("__zbSeek never appeared (injection failed?)");
            const probe = (await send("Runtime.evaluate", {
              expression: "typeof window.__zbSeek === 'function' ? String(window.__zbBuildMs || 0) : 'no'",
              returnByValue: true,
            })) as { result?: { value?: string } };
            const value = probe.result?.value;
            if (value && value !== "no") {
              buildMs = Number(value) || 0;
              break;
            }
            await new Promise((r) => setTimeout(r, 250));
          }

          // Capture timestamps: dense through the build, sparse on the hold,
          // always ending exactly at durationSec.
          const durationMs = opts.durationSec * 1000;
          const stamps: number[] = [0];
          for (let t = buildStep; t < Math.min(buildMs + buildStep, durationMs); t += buildStep) stamps.push(t);
          for (let t = buildMs + buildStep; t < durationMs - 250; t += holdStep) stamps.push(t);
          stamps.push(durationMs - 1);

          for (const tMs of stamps) {
            await send("Runtime.evaluate", {
              expression: `window.__zbSeek(${Math.round(tMs)})`,
            });
            const shot = (await send("Page.captureScreenshot", {
              format: "png",
              captureBeyondViewport: false,
            })) as { data: string };
            frameCount += 1;
            frameTimes.push(Math.min(tMs / 1000, opts.durationSec));
            writeFileSync(join(outDir, `frame-${String(frameCount).padStart(4, "0")}.png`), shot.data, "base64");
          }
          try { ws.close(); } catch { /* */ }
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
    });
  } finally {
    child.kill("SIGKILL");
  }
  return { count: frameCount, times: frameTimes };
}

/** Frames → concat-demuxer list with per-frame durations (VFR). */
export function writeFrameConcatList(
  framesDir: string,
  frameTimes: number[],
  segmentDuration: number,
  listPath: string,
): string[] {
  const names: string[] = [];
  for (let i = 1; i <= frameTimes.length; i++) {
    names.push(`frame-${String(i).padStart(4, "0")}.png`);
  }
  const lines: string[] = [];
  names.forEach((name, i) => {
    const t = frameTimes[i]! / 1000;
    const next = i + 1 < names.length ? frameTimes[i + 1]! / 1000 : segmentDuration;
    const d = Math.min(Math.max(next - t, 1 / 60), segmentDuration - t);
    lines.push(`file '${join(framesDir, name)}'`);
    if (d > 0) lines.push(`duration ${d.toFixed(4)}`);
  });
  // concat demuxer ignores the last duration entry unless the file repeats.
  lines.push(`file '${join(framesDir, names[names.length - 1]!)}'`);
  writeFileSync(listPath, lines.join("\n"));
  return names;
}
