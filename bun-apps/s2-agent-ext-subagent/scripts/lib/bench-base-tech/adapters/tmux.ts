/**
 * tmux adapter — the SCREEN-SCRAPE lane: the tmux SERVER owns the pty; the
 * driver is an out-of-band client (`send-keys` in, `capture-pane` out — no
 * byte lane, no DA handshake, no xterm reconstruction needed for text
 * predicates). Settle adds the two-consecutive-stable-captures condition
 * (spec D4): a capture mid-churn is not a settle signal.
 */
import type { BenchAdapter, LaunchCtx, Session, SettleResult, SettleView } from "../types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tmux(args: string[]): { text: string } {
  const p = Bun.spawnSync(["tmux", ...args], { env: { ...process.env } as Record<string, string> });
  return { text: p.stdout.toString() };
}

export const tmuxAdapter: BenchAdapter = {
  id: "tmux",
  evidenceLanes: { renderedTruth: true, structured: false, dialogs: "keystroke", asyncEvents: "screen" },
  async launch(ctx: LaunchCtx): Promise<Session> {
    const name = `bench13-${Date.now().toString(36)}`;
    // Server-side pty with fixed geometry; the launcher inherits the key env
    // (tmux passes the server env; set explicitly so the child sees it).
    const envPairs = Object.entries(ctx.env)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const launch = Bun.spawnSync(
      [
        "tmux",
        "new-session",
        "-d",
        "-x",
        String(ctx.cols),
        "-y",
        String(ctx.rows),
        "-s",
        name,
        `env ${envPairs} TERM=xterm-256color '${ctx.sh}'`,
      ],
      { cwd: ctx.cwd, env: { ...process.env } as Record<string, string> },
    );
    if (launch.exitCode !== 0) throw new Error(`tmux new-session failed: ${launch.stderr.toString()}`);

    let lastCapture = "";
    const capture = (): string => {
      lastCapture = tmux(["capture-pane", "-t", name, "-p"]).text;
      return lastCapture;
    };

    const session: Session = {
      async submit(text: string) {
        // Rendered-truth boot gate: pane must have content first.
        for (let i = 0; i < 60 && capture().trim().length === 0; i++) await sleep(1500);
        tmux(["send-keys", "-t", name, "-l", text]);
        await sleep(250);
        tmux(["send-keys", "-t", name, "Enter"]);
        // Verified submit on the capture lane: spinner visible, else re-Enter.
        for (let attempt = 0; attempt < 2; attempt++) {
          await sleep(6000);
          if (/Working/.test(capture())) return;
          tmux(["send-keys", "-t", name, "Enter"]);
        }
      },
      async awaitSettled(deadlineMs: number, pred: (v: SettleView) => boolean): Promise<SettleResult> {
        const t0 = Date.now();
        let stableCount = 0;
        let prev = "";
        let view: SettleView = { screen: capture(), structured: null };
        while (Date.now() - t0 < deadlineMs) {
          await sleep(300);
          const s = capture();
          // D4: two consecutive captures ≥300ms apart with identical text —
          // then (and only then) evaluate the predicate.
          if (s === prev) stableCount++;
          else stableCount = 0;
          prev = s;
          if (stableCount >= 2) {
            view = { screen: s, structured: null };
            if (pred(view)) return { settled: true, ms: Date.now() - t0, lastView: view };
            stableCount = 0; // pred not met — keep polling, require fresh stability
          }
        }
        return { settled: false, ms: Date.now() - t0, lastView: view };
      },
      screenText: () => lastCapture,
      async writeRaw(bytes: string) {
        // Gesture lane: literal keys + a real Enter.
        const literal = bytes.replace(/\r$/, "");
        if (literal) tmux(["send-keys", "-t", name, "-l", literal]);
        if (bytes.endsWith("\r")) tmux(["send-keys", "-t", name, "Enter"]);
        await sleep(500);
      },
      async close() {
        try {
          tmux(["kill-session", "-t", name]);
        } catch {
          /* already gone */
        }
      },
    };
    return session;
  },
};
