import { useState, useEffect, useRef } from "react";
import { useSchemaDefaults, type ActionDefaults } from "./useSchemaDefaults";

/**
 * Manages form state with automatic server-default merging and user-edit tracking.
 *
 * On mount, state is initialized from `fallbackDefaults`. When server defaults
 * arrive (via useSchemaDefaults), they are merged in — but only for fields the
 * user hasn't manually edited yet.
 *
 * Replaces the repeated pattern of: useState + userModifiedRef + useEffect(serverDefaults) + setField
 * that was duplicated across CommandForm, VideoGenerateView, and VideoRestoreView.
 */
export function useDefaultState(
  action: string,
  fallbackDefaults: Record<string, any>,
): {
  state: Record<string, any>;
  setField: (key: string, value: any) => void;
  serverDefaults: ActionDefaults | null;
} {
  const serverDefaults = useSchemaDefaults(action);
  const [state, setState] = useState<Record<string, any>>({ ...fallbackDefaults });
  const userModifiedRef = useRef<Set<string>>(new Set());

  // Apply server defaults once they load, skipping user-touched fields
  useEffect(() => {
    if (!serverDefaults) return;
    setState((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(serverDefaults)) {
        if (k === "pipeline_steps" || k === "self_tests") continue;
        if (!userModifiedRef.current.has(k)) next[k] = v;
      }
      // Auto-update steps when pipeline changes (if user hasn't manually set steps)
      if (serverDefaults.pipeline_steps && !userModifiedRef.current.has("steps")) {
        const ps = serverDefaults.pipeline_steps[next.pipeline ?? "zimage"];
        if (ps !== undefined) next.steps = ps;
      }
      return next;
    });
  }, [serverDefaults]);

  const setField = (key: string, value: any) => {
    userModifiedRef.current.add(key);
    setState((prev) => {
      const next = { ...prev, [key]: value };
      // When pipeline changes, auto-update steps if the user hasn't manually set it
      if (key === "pipeline" && serverDefaults?.pipeline_steps && !userModifiedRef.current.has("steps")) {
        const ps = serverDefaults.pipeline_steps[value];
        if (ps !== undefined) next.steps = ps;
      }
      return next;
    });
  };

  return { state, setField, serverDefaults };
}
