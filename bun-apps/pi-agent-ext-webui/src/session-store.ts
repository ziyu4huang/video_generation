/**
 * session-store.ts — the client-visible session state (architecture v2 §3.3).
 *
 * The research-backed lesson (pi-client "authoritative snapshots, not
 * optimistic state"; gptme/OmniTerm "render from the structured event stream")
 * is: a browser that opens mid-session (or refreshes) must see the agent's
 * history, not only future frames. The store accumulates the outbound
 * `WebFrame` stream the wiring broadcasts — agent-stream frames (message_*,
 * tool_*, turn_*), mutex signals — into a bounded transcript, and hands a
 * connect-time `snapshot` to a new WS client.
 *
 * Pure-ish: no I/O, no `bun`, no `pi`; state only. The wiring feeds it by
 * wrapping the Broadcaster (append-then-broadcast), so every frame that
 * reaches clients also reaches the store — including mutex frames that the
 * notifier broadcasts directly. The wiring additionally drives
 * `setPresentId` (registerPending / cancel / resolve) because the current
 * presentation id is registry knowledge, not a broadcast frame.
 */
import type { WebFrame } from "./protocol.js";

/** Transcript cap — newest N frames kept (a long agent session streams a lot). */
export const TRANSCRIPT_CAP = 500;

/** The co-driving driver, as the client sees it (null = idle). */
export type SessionDriver = "tui" | "web" | null;

/**
 * The connect-time snapshot payload: a bounded replay of the agent stream plus
 * the current presentation id and mutex driver. Sent to each WS client on
 * open, BEFORE any live frames, so a mid-session open sees history.
 */
export interface SessionSnapshot {
  transcript: WebFrame[];
  /** The pending presentation's respond id (null when none). */
  presentId: string | null;
  /** Current mutex driver (null when idle). */
  driver: SessionDriver;
}

/** The store. `append` is called for EVERY outbound frame; `snapshot` on each
 *  WS open; `clear` on session_shutdown (the server survives, but a NEW
 *  session must not inherit the previous session's transcript). */
export interface SessionStore {
  append(frame: WebFrame): void;
  /** The wiring drives this on pending-presentation changes. */
  setPresentId(id: string | null): void;
  snapshot(): SessionSnapshot;
  clear(): void;
}

export function createSessionStore(cap = TRANSCRIPT_CAP): SessionStore {
  let transcript: WebFrame[] = [];
  let presentId: string | null = null;
  let driver: SessionDriver = null;

  return {
    append(frame: WebFrame): void {
      transcript.push(frame);
      // cards-ux2 (04) / tab-views (01a): card frames AND reports are sparse
      // and review-critical — a plain FIFO would evict them early in any long
      // session (browser-probe-proven). Evict only NON-card/NON-report frames,
      // oldest first. webui-v3 diet follow-up: appexec frames ride the same
      // protection — they carry HITL tool RESULTS (the answer payload a
      // settled tool needs); under the v3 pure-HITL frame mix they are as
      // sparse and review-critical as cards, and the diet removed the log
      // frames that used to absorb eviction pressure.
      if (transcript.length > cap) {
        let remove = transcript.length - cap;
        for (let i = 0; i < transcript.length && remove > 0; i += 1) {
          const t = transcript[i]?.type;
          if (t === "card" || t === "card_done" || t === "report" || t === "appexec") continue;
          transcript.splice(i, 1);
          remove -= 1;
          i -= 1;
        }
      }
      // Driver tracking from the frames we see: a block tells us who holds the
      // lock; settle / force-release / shutdown clear it. (The cast is safe:
      // the literal "mutex_blocked" member guarantees blocked/by are
      // "tui"|"web"; the generic forward-compat member keeps TS from narrowing
      // past `unknown` for `.by`.)
      if (frame.type === "mutex_blocked") {
        driver = frame.by as SessionDriver;
      } else if (
        frame.type === "mutex_force_release" ||
        frame.type === "agent_settled"
      ) {
        driver = null;
      }
    },
    setPresentId(id: string | null): void {
      presentId = id;
    },
    snapshot(): SessionSnapshot {
      return { transcript: [...transcript], presentId, driver };
    },
    clear(): void {
      transcript = [];
      presentId = null;
      driver = null;
    },
  };
}
