import { useState, useEffect } from "react";

type ActionDefaults = Record<string, any> & {
  pipeline_steps?: Record<string, number>;
};

// Module-level singleton: entire SPA makes at most one HTTP request
let _cache: Record<string, ActionDefaults> | null = null;
let _promise: Promise<Record<string, ActionDefaults> | null> | null = null;

function fetchOnce(): Promise<Record<string, ActionDefaults> | null> {
  if (_promise) return _promise;
  _promise = fetch("/api/schema-defaults")
    .then((r) => r.json())
    .then((data) => {
      if (data.ok) {
        _cache = data.defaults;
        return _cache;
      }
      return null;
    })
    .catch(() => null);
  return _promise;
}

export function useSchemaDefaults(action: string): ActionDefaults | null {
  const [defaults, setDefaults] = useState<ActionDefaults | null>(
    _cache?.[action] ?? null,
  );

  useEffect(() => {
    if (_cache) {
      setDefaults(_cache[action] ?? null);
      return;
    }
    fetchOnce().then((all) => {
      if (all) setDefaults(all[action] ?? null);
    });
  }, [action]);

  return defaults;
}
