/**
 * rpc adapter — the STRUCTURED lane: spawn the launcher with `--mode rpc` and
 * speak the deployed JSONL protocol (commands on stdin, responses + streamed
 * AgentSessionEvents on stdout). Shapes pinned against the deployed tree
 * (self-arc-13 discovery):
 *   - command: {type:"prompt", id, message} → preflight-gated success response
 *   - command: {type:"get_state", id} → data.model / isStreaming / ...
 *   - command: {type:"get_last_assistant_text", id} → data
 *   - turn completion: streamed event {type:"agent_settled"}
 * No tty exists: TUI surfaces (viewer, panels, status bar) are UNREACHABLE —
 * recorded as capability cells, not failures (spec D8).
 */
import type { BenchAdapter, LaunchCtx, Session, SettleResult, SettleView, StateInfo } from "../types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RpcLine {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

export const rpcAdapter: BenchAdapter = {
  id: "rpc",
  evidenceLanes: { renderedTruth: false, structured: true, dialogs: "protocol", asyncEvents: "stream" },
  async launch(ctx: LaunchCtx): Promise<Session> {
    const proc = Bun.spawn([ctx.sh, "--mode", "rpc"], {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.env } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void Bun.readableStreamToText(proc.stderr).catch(() => {});

    const lines: RpcLine[] = [];
    const waiters: Array<{ id: string; resolve: (l: RpcLine) => void }> = [];
    let sawAgentSettled = false;
    let sawNotification = false;

    const pump = async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (;;) {
            const nl = buf.indexOf("\n");
            if (nl < 0) break;
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let parsed: RpcLine;
            try {
              parsed = JSON.parse(line) as RpcLine;
            } catch {
              continue; // non-JSON noise on stdout
            }
            if (parsed.type === "agent_settled") sawAgentSettled = true;
            // Notification heuristic (discovery 2026-09-08): background-subagent
            // completions surface either as a typed notification event or as an
            // extension_ui_request method:"notify" whose payload mentions it.
            if (/notification/i.test(JSON.stringify(parsed)) && parsed.type !== "extension_ui_request") {
              sawNotification = true;
            }
            if (
              parsed.type === "extension_ui_request" &&
              (parsed as { method?: string }).method === "notify" &&
              /notification|subagent/i.test(JSON.stringify(parsed))
            ) {
              sawNotification = true;
            }
            lines.push(parsed);
            const w = waiters.findIndex((x) => x.id === parsed.id);
            if (w >= 0) waiters.splice(w, 1)[0].resolve(parsed);
          }
        }
      } catch {
        /* stream closed on kill */
      }
    };
    void pump();

    let seq = 0;
    const command = async (cmd: Record<string, unknown>): Promise<RpcLine> => {
      const id = `bench-${++seq}`;
      const payload = JSON.stringify({ ...cmd, id });
      proc.stdin.write(`${payload}\n`);
      const resp = await Promise.race([
        new Promise<RpcLine>((resolve) => waiters.push({ id, resolve })),
        sleep(30000).then(() => ({ id, type: "timeout" }) as RpcLine),
      ]);
      return resp;
    };

    const lastAssistantText = async (): Promise<string> => {
      const r = await command({ type: "get_last_assistant_text" });
      const d = r.data as { text?: string; content?: string } | string | undefined;
      if (typeof d === "string") return d;
      return d?.text ?? d?.content ?? "";
    };

    const session: Session = {
      async submit(text: string) {
        const r = await command({ type: "prompt", message: text });
        if (r.type === "timeout" || r.success === false) {
          throw new Error(`rpc prompt rejected: ${r.error ?? "timeout"}`);
        }
        sawAgentSettled = false; // settled flips on THIS turn's event
      },
      async awaitSettled(deadlineMs: number, pred: (v: SettleView) => boolean): Promise<SettleResult> {
        const t0 = Date.now();
        let view: SettleView = { screen: null, structured: lines[lines.length - 1] ?? null };
        while (Date.now() - t0 < deadlineMs) {
          await sleep(150);
          // rpc settle semantics (spec D4): response success AND turn-completion
          // event observed — the predicate additionally checks the payload.
          if (sawAgentSettled) {
            const structured = { agentSettled: true, notification: sawNotification, lines: lines.slice(-40) };
            view = { screen: null, structured };
            if (pred(view)) return { settled: true, ms: Date.now() - t0, lastView: view };
          }
        }
        return { settled: false, ms: Date.now() - t0, lastView: view };
      },
      async stateProbe(): Promise<StateInfo | null> {
        const r = await command({ type: "get_state" });
        if (r.success === false) return { raw: r };
        // Discovery 2026-09-08: deployed data.model is an OBJECT ({id:"glm-5.3",
        // name, reasoning, contextWindow, ...}), not a string.
        const d = r.data as { model?: { id?: string; name?: string } | string } | undefined;
        const model = typeof d?.model === "string" ? d.model : (d?.model?.id ?? d?.model?.name ?? "");
        return { model, raw: r.data ?? null };
      },
      /** Structured async-event evidence for the subagent-dispatch case. */
      async lastAssistantText() {
        return lastAssistantText();
      },
      /** self-arc-15 cx-midturn-abort: the protocol's own abort lever. */
      async abortTurn() {
        const r = await command({ type: "abort" });
        return r.success !== false;
      },
      /** self-arc-15: latest get_entries snapshot (structured transcript view). */
      async entriesSnapshot() {
        const r = await command({ type: "get_entries" });
        return r.success === false ? null : (r.data ?? null);
      },
      async close() {
        try {
          proc.stdin.end();
          proc.kill(9);
        } catch {
          /* already gone */
        }
      },
    } as Session;
    return session;
  },
};
