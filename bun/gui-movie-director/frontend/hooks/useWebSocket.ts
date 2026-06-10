import { useState, useEffect, useRef, useCallback } from "react";
import type { JobInfo } from "../app";

interface WsMessage {
  type: string;
  jobId?: string;
  line?: string;
  stream?: "stdout" | "stderr";
  exitCode?: number;
  outputFiles?: string[];
}

export function useWebSocket() {
  const [logs, setLogs] = useState<string[]>([]);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onclose = () => {
      setConnected(false);
      // Reconnect after 2s
      reconnectTimer.current = window.setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);

        if (msg.type === "log" && msg.line) {
          setLogs((prev) => [...prev, msg.line!]);
        }

        if (msg.type === "job_complete") {
          setJobStatus("completed");
        }

        if (msg.type === "job_failed") {
          setJobStatus("failed");
        }
      } catch {
        // Ignore malformed messages
      }
    };
  }, []);

  const subscribe = useCallback((jobId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", jobId }));
    }
    setLogs([]);
    setJobStatus(null);
  }, []);

  const unsubscribe = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "unsubscribe" }));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { logs, jobStatus, connected, subscribe, unsubscribe };
}
