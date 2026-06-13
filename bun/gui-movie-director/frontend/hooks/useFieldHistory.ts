import { useState, useCallback } from "react";

const MAX_HISTORY = 5;

function storageKey(action: string, fieldKey: string): string {
  return `fh:${action}:${fieldKey}`;
}

function readHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeHistory(key: string, values: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // localStorage may be unavailable (private mode, quota exceeded)
  }
}

export function useFieldHistory(action: string, fieldKey: string) {
  const key = storageKey(action, fieldKey);
  const [history, setHistory] = useState<string[]>(() => readHistory(key));

  const push = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setHistory((prev) => {
        const deduped = [trimmed, ...prev.filter((v) => v !== trimmed)].slice(
          0,
          MAX_HISTORY
        );
        writeHistory(key, deduped);
        return deduped;
      });
    },
    [key]
  );

  return { history, push };
}
