/**
 * bun-terminal adapter — the INCUMBENT lane: Bun.spawn's native terminal
 * option owns the pty (Bun ≥1.3.5; no node-pty). This is the arm tui-drive.ts
 * already runs on (10/10 deployed sweep, arc-12), so it doubles as the
 * benchmark's CONTROL: if this lane goes red, the abstraction is wrong, not
 * the tech.
 */
import { chunkBytes, LIVE_MARKER_RE, makeQueryResponder, screenText, XTerm } from "../screen.js";
import type { BenchAdapter, LaunchCtx, Session, SettleResult, SettleView } from "../types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const bunTerminalAdapter: BenchAdapter = {
  id: "bun-terminal",
  evidenceLanes: { renderedTruth: true, structured: false, dialogs: "keystroke", asyncEvents: "screen" },
  async launch(ctx: LaunchCtx): Promise<Session> {
    const term = new XTerm({ cols: ctx.cols, rows: ctx.rows, allowProposedApi: true });
    let lastScreen = "";
    const feedChunks: Uint8Array[] = [];
    let draining = false;

    const drain = async () => {
      if (draining) return;
      draining = true;
      while (feedChunks.length > 0) {
        const chunk = feedChunks.shift();
        if (chunk) term.write(chunk);
        await sleep(0); // AWAITED between chunks — the 64B lesson
      }
      draining = false;
    };

    const ttyWrite = (s: string | Uint8Array) => {
      (proc as unknown as { terminal: { write(x: Uint8Array | string): void } }).terminal.write(s);
    };
    const respond = makeQueryResponder(ttyWrite);

    const proc = Bun.spawn([ctx.sh], {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.env, TERM: "xterm-256color" } as Record<string, string>,
      terminal: {
        cols: ctx.cols,
        rows: ctx.rows,
        data(_t, data) {
          const u8 = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
          respond(u8);
          for (const c of chunkBytes(u8)) feedChunks.push(c);
          void drain();
        },
      },
    });

    const readScreen = () => {
      lastScreen = screenText(term);
      return lastScreen;
    };

    const session: Session = {
      async submit(text: string) {
        // Rendered-truth boot gate (#2208): never send before first render.
        for (let i = 0; i < 60 && term.buffer.active.length === 0; i++) await sleep(1500);
        ttyWrite(text);
        await sleep(250);
        ttyWrite("\r");
        // Verified submit: buffer left the input when the spinner (or the
        // caller's latch) shows — else one guarded re-Enter.
        for (let attempt = 0; attempt < 2; attempt++) {
          await sleep(6000);
          const s = readScreen();
          if (/Working/.test(s) || !LIVE_MARKER_RE.test(s)) return;
          ttyWrite("\r");
        }
      },
      async awaitSettled(deadlineMs: number, pred: (v: SettleView) => boolean): Promise<SettleResult> {
        const t0 = Date.now();
        let view: SettleView = { screen: readScreen(), structured: null };
        while (Date.now() - t0 < deadlineMs) {
          await sleep(150);
          view = { screen: readScreen(), structured: null };
          if (pred(view)) return { settled: true, ms: Date.now() - t0, lastView: view };
        }
        return { settled: false, ms: Date.now() - t0, lastView: view };
      },
      screenText: () => lastScreen,
      async writeRaw(bytes: string) {
        ttyWrite(bytes);
        await sleep(300);
      },
      async close() {
        try {
          proc.kill(9);
        } catch {
          /* already gone */
        }
      },
    };
    return session;
  },
};
