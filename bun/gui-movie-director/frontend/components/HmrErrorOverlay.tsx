import React, { useState, useEffect } from "react";

interface ErrorDetail {
  message: string;
  file: string;
  line: number;
  col: number;
}

export function HmrErrorOverlay() {
  const [errors, setErrors] = useState<ErrorDetail[]>([]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "hmr-error" && Array.isArray(msg.errors)) {
          setErrors(msg.errors);
        } else if (msg.type === "hmr-reload") {
          setErrors([]);
        }
      } catch { /* ignore */ }
    };

    ws.onerror = () => ws.close();
    return () => ws.close();
  }, []);

  if (!errors.length) return null;

  return (
    <div className="hmr-error-overlay">
      <div className="hmr-error-box">
        <div className="hmr-error-title">TypeScript Build Error</div>
        {errors.map((e, i) => (
          <div key={i} className="hmr-error-item">
            {e.file && (
              <span className="hmr-error-loc">
                {e.file}{e.line ? `:${e.line}` : ""}{e.col ? `:${e.col}` : ""}
              </span>
            )}
            <pre className="hmr-error-msg">{e.message}</pre>
          </div>
        ))}
        <div className="hmr-error-hint">Fix the error above — this overlay clears automatically on successful rebuild.</div>
      </div>
    </div>
  );
}
