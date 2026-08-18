// Module-level WebSocket singleton for broadcast notifications (job_complete,
// gallery-updated, hmr-reload, etc.). Keeps exactly one WS connection open for
// the lifetime of the SPA, shared across all subscribers.
//
// Note: this is separate from useWebSocket.ts, which manages the subscribe/
// unsubscribe protocol for streaming job logs. That hook opens its own connection
// because it needs fine-grained control over the protocol state.

type MessageHandler = (msg: Record<string, any>) => void;

const _handlers = new Set<MessageHandler>();
let _ws: WebSocket | null = null;
// `number`, not ReturnType<typeof window.setTimeout>: this package compiles with
// both the DOM lib and @types/bun in scope, and they disagree — bun's setTimeout
// returns a Timeout while the `window.` call below returns a number, so the
// ReturnType form resolved to the wrong one. This module is browser-only (it
// uses window/WebSocket), where the handle is a number.
let _reconnectTimer: number | null = null;
let _reconnectDelay = 1000;

function _connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  _ws = ws;

  ws.onopen = () => { _reconnectDelay = 1000; };

  ws.onclose = () => {
    if (_handlers.size > 0) {
      // Clear any pending reconnect timer before scheduling a new one. Without
      // this, a rapid connect/close cycle (e.g. server flapping) would stack
      // timers — _reconnectTimer would track only the latest, leaking the rest.
      // (_connect's readyState guard still prevents duplicate sockets, but the
      // leaked timers each fire a redundant _connect.)
      if (_reconnectTimer !== null) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
      }
      _reconnectTimer = window.setTimeout(() => {
        _reconnectTimer = null;
        _connect();
      }, _reconnectDelay);
      _reconnectDelay = Math.min(_reconnectDelay * 2, 30000);
    }
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      for (const h of _handlers) h(msg);
    } catch { /* ignore malformed */ }
  };
}

export function addListener(handler: MessageHandler): () => void {
  _handlers.add(handler);
  _connect(); // no-op if already connected
  return () => {
    _handlers.delete(handler);
  };
}
