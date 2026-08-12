/**
 * broadcaster.ts — the injected port around the volatile transport (specs/04 §3).
 *
 * A stable one-method interface so the deep module (WebTransport) and the wiring
 * (extensions/webui.ts) depend on a {@link Broadcaster}, NEVER on Bun/WS
 * specifics. This is the future Path-B swap point: later swap the WS adapter for
 * a `PiServerService` lease without touching the protocol logic or the web
 * client.
 *
 * Two adapters implement this port:
 *  - {@link WebServer}      — prod (WS client-set fan-out; src/web-server.ts)
 *  - {@link MemoryBroadcaster} — test sink (captures frames for assertions; here)
 *
 * Purity note: this module has no I/O and no Bun import — it is the abstract
 * port + an inert in-memory test adapter.
 */
import type { WebFrame } from "./protocol.js";

/**
 * The broadcaster port: fire-and-forget fan-out of one outbound frame to all
 * connected web clients. Implementations MUST NOT throw on a dead socket (spec
 * §6: broadcast is fire-and-forget).
 */
export interface Broadcaster {
  broadcast(frame: WebFrame): void;
}

/**
 * In-memory {@link Broadcaster} sink for unit tests: captures every broadcast
 * frame in order so assertions can inspect the outbound stream without a real
 * socket. NOT used in prod.
 */
export class MemoryBroadcaster implements Broadcaster {
  /** Captured outbound frames, in broadcast order. */
  readonly frames: WebFrame[] = [];

  broadcast(frame: WebFrame): void {
    this.frames.push(frame);
  }
}
