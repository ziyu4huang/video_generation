/**
 * bun-pty adapter — the RAW-PTY lane (map D1): macOS `script -q /dev/null`
 * allocates the pty; Bun talks plain stdio pipes (NO Bun terminal API). The
 * child still gets a real tty (so the TUI renders + queries flow), and the
 * byte lane stays bidirectional: DA queries arrive on our stdout, replies go
 * back through our stdin. Screen reconstruction is the same xterm-headless
 * stack — the ONLY variable versus bun-terminal is who owns the pty.
 */
import { chunkBytes, makeQueryResponder, screenText, XTerm } from "../screen.js";
import type { BenchAdapter, LaunchCtx, Session, SettleResult, SettleView } from "../types.js";
import { LaneUnavailableError } from "../types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const bunPtyAdapter: BenchAdapter = {
  id: "bun-pty",
  evidenceLanes: { renderedTruth: true, structured: false, dialogs: "keystroke", asyncEvents: "screen" },
  async launch(ctx: LaunchCtx): Promise<Session> {
    const term = new XTerm({ cols: ctx.cols, rows: ctx.rows, allowProposedApi: true });
    let lastScreen = "";
    const feedChunks: Uint8Array[] = [];
    let draining = false;

    const stdinWrite = (s: string) => {
      proc.stdin.write(s);
    };
    const respond = makeQueryResponder(stdinWrite);

    // script(1): allocate a pty, attach the launcher; -q quiet, /dev/null typescript.
    // BSD script sets the child's TERM from its own env, so TERM rides ctx.env.
    const proc = Bun.spawn(["script", "-q", "/dev/null", ctx.sh], {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.env, TERM: "xterm-256color" } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const pump = async () => {
      const reader = proc.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          respond(value);
          for (const c of chunkBytes(value)) feedChunks.push(c);
          void drain();
        }
      } catch {
        /* stream closed on kill */
      }
    };
    const drain = async () => {
      if (draining) return;
      draining = true;
      while (feedChunks.length > 0) {
        const chunk = feedChunks.shift();
        if (chunk) term.write(chunk);
        await sleep(0);
      }
      draining = false;
    };
    void pump();
    // script's own stderr — drain so pipes never fill, and capture it: macOS
    // BSD script(1) calls tcgetattr(stdin) at boot and HARD-FAILS on a
    // socket/pipe stdin ("tcgetattr/ioctl: Operation not supported on
    // socket", exit 1, zero bytes) — map D1 arbitration evidence.
    const stderrText = Bun.readableStreamToText(proc.stderr).catch(() => "");
    await sleep(2500);
    if (proc.exitCode !== null) {
      const err = await stderrText;
      throw new LaneUnavailableError(
        `script(1) exited ${proc.exitCode} at boot: ${err.trim().slice(0, 200) || "(no stderr)"}`,
      );
    }

    const readScreen = () => {
      lastScreen = screenText(term);
      return lastScreen;
    };

    const session: Session = {
      async submit(text: string) {
        // Rendered-truth boot gate (#2208): never send before first render.
        for (let i = 0; i < 60 && term.buffer.active.length === 0; i++) await sleep(1500);
        stdinWrite(text);
        await sleep(250);
        stdinWrite("\r");
        // Verified submit (#2208-class, hardened self-arc-15): a QUIET screen
        // is NOT proof of submission — a freshly-booted TUI is quiet while the
        // eaten Enter leaves the prompt sitting in the COMPOSER. Evidence of
        // submission: spinner/Working appears, OR the text left the composer
        // region (bottom rows). One guarded re-Enter otherwise.
        const composerHolds = (): boolean => {
          const lines = readScreen().split("\n");
          return lines.slice(-6).some((l) => l.includes(text.slice(0, 40)));
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          await sleep(6000);
          const s = readScreen();
          if (/Working/.test(s)) return;
          if (!composerHolds()) return;
          stdinWrite("\r");
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
      // LIVE view (self-arc-15): returning the cached lastScreen froze the
      // complex executor's direct polls — a poller that never calls
      // awaitSettled/submit saw the boot-time frame forever. Refresh on read.
      screenText: () => readScreen(),
      async writeRaw(bytes: string) {
        stdinWrite(bytes);
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
