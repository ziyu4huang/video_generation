import { useState, useEffect } from "react";

export interface LoraInfo {
  name: string;
  path: string;
  description?: string;
  arch?: string;
  format?: string;
  pipeline?: string[];
  rank?: number;
  size_bytes?: number;
  folder_size_bytes?: number;
  recommended_scale?: number;
  trigger_words?: string[];
  compatible_with?: string[];
  source?: string;
  source_url?: string;
  created_at?: string;
  weight_file?: string;
  test_prompt?: string;
  notes?: string;
  converted_from?: { format?: string; size_bytes?: number };
}

// Module-scope cache: the installed-LoRA list rarely changes mid-session, so a
// single fetch is shared across every LoraField instance (t2i/i2i/anime2real).
let _cache: LoraInfo[] | null = null;
let _fetching: Promise<LoraInfo[]> | null = null;

async function fetchLoras(): Promise<LoraInfo[]> {
  if (_cache) return _cache;
  if (_fetching) return _fetching;
  _fetching = fetch("/api/models/loras")
    .then((r) => (r.ok ? r.json() : []))
    .then((d: LoraInfo[]) => {
      _cache = Array.isArray(d) ? d : [];
      _fetching = null;
      return _cache;
    })
    .catch(() => {
      _fetching = null;
      return [];
    });
  return _fetching;
}

export function useLoras(): { loras: LoraInfo[]; loading: boolean } {
  const [loras, setLoras] = useState<LoraInfo[]>(_cache ?? []);
  const [loading, setLoading] = useState(!_cache);
  useEffect(() => {
    let alive = true;
    fetchLoras().then((d) => {
      if (alive) {
        setLoras(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return { loras, loading };
}
