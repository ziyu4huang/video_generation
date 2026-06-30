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

export function useAllFieldHistories(action: string, fieldKeys: string[]) {
  const [histories, setHistories] = useState<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {};
    for (const fk of fieldKeys) {
      result[fk] = readHistory(storageKey(action, fk));
    }
    return result;
  });

  const push = useCallback(
    (fieldKey: string, value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      const sk = storageKey(action, fieldKey);
      setHistories((prev) => {
        const prevArr = prev[fieldKey] ?? [];
        const deduped = [trimmed, ...prevArr.filter((v) => v !== trimmed)].slice(0, MAX_HISTORY);
        writeHistory(sk, deduped);
        return { ...prev, [fieldKey]: deduped };
      });
    },
    [action]
  );

  const getHistory = useCallback(
    (fieldKey: string): { history: string[] } | null => {
      const h = histories[fieldKey];
      return h !== undefined ? { history: h } : null;
    },
    [histories]
  );

  return { getHistory, push };
}
