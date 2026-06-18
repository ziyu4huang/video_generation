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
let _reconnectTimer: ReturnType<typeof window.setTimeout> | null = null;
let _reconnectDelay = 1000;

function _connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  _ws = ws;

  ws.onopen = () => { _reconnectDelay = 1000; };

  ws.onclose = () => {
    if (_handlers.size > 0) {
      _reconnectTimer = window.setTimeout(_connect, _reconnectDelay);
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
