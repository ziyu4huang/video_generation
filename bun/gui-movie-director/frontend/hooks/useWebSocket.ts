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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const pendingSubscribe = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (pendingSubscribe.current) {
        ws.send(JSON.stringify({ type: "subscribe", jobId: pendingSubscribe.current }));
        pendingSubscribe.current = null;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      // Unblock any waiting UI if a job was in progress
      setJobStatus((prev) => (prev === "completed" || prev === "failed" ? prev : "failed"));
      reconnectTimer.current = window.setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);

        if (msg.type === "log" && msg.line) {
          setLogs((prev) => [...prev, { line: msg.line!, stream: msg.stream ?? "stdout" }]);
        }

        if (msg.type === "job_complete") {
          setJobStatus("completed");
          if (msg.outputFiles) setOutputFiles(msg.outputFiles);
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
    setLogs([]);
    setJobStatus(null);
    setOutputFiles([]);
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

  return { logs, jobStatus, outputFiles, connected, subscribe, unsubscribe };
}
