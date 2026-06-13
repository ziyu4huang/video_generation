import { useState, useEffect, useRef, useCallback } from "react";

interface WsMessage {
  type: string;
  jobId?: string;
  line?: string;
  stream?: "stdout" | "stderr";
  exitCode?: number;
  outputFiles?: string[];
}

export interface LogEntry {
  line: string;
  stream: "stdout" | "stderr";
}

export function useWebSocket() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [outputFiles, setOutputFiles] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectDelay = useRef(1000);
  const pendingSubscribe = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectDelay.current = 1000; // Reset backoff on successful connect
      if (pendingSubscribe.current) {
        ws.send(JSON.stringify({ type: "subscribe", jobId: pendingSubscribe.current }));
        pendingSubscribe.current = null;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      // Don't overwrite terminal states — only reset if no definitive result yet
      setJobStatus((prev) => (prev === "completed" || prev === "failed" ? prev : null));
      // Exponential backoff: 1s → 2s → 4s → ... → 30s cap
      reconnectTimer.current = window.setTimeout(connect, reconnectDelay.current);
      reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);

        if (msg.type === "log" && msg.line) {
          setLogs((prev) => [...prev, { line: msg.line!, stream: msg.stream ?? "stdout" }]);
          // Parse progress percentage from log line
          const pm = msg.line.match(/\b(\d{1,3})%/) ?? msg.line.match(/step (\d+) of (\d+)/i);
          if (pm) {
            const pct = pm[2] ? Math.round((+pm[1] / +pm[2]) * 100) : +pm[1];
            if (pct >= 0 && pct <= 100) setProgress(pct);
          }
        }

        if (msg.type === "job_complete") {
          setJobStatus("completed");
          setProgress(null);
          if (msg.outputFiles) setOutputFiles(msg.outputFiles);
        }

        if (msg.type === "job_failed") {
          setJobStatus("failed");
          setProgress(null);
        }
      } catch {
        // Ignore malformed messages
      }
    };
  }, []);

  const subscribe = useCallback((jobId: string) => {
    setLogs([]);
    setJobStatus(null);
    setOutputFiles([]);
    setProgress(null);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", jobId }));
    } else {
      pendingSubscribe.current = jobId;
    }
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

  return { logs, jobStatus, outputFiles, connected, progress, subscribe, unsubscribe };
}
