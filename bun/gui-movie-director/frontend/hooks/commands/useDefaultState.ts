import { useState, useEffect, useRef } from "react";
import { useSchemaDefaults, type ActionDefaults } from "../queries/useSchemaDefaults";
import { RESOLUTION_MAP, resolutionKey } from "../../../schemas/shared";

/**
 * Manages form state with automatic server-default merging and user-edit tracking.
 *
 * On mount, state is initialized from `fallbackDefaults`. When server defaults
 * arrive (via useSchemaDefaults), they are merged in — but only for fields the
 * user hasn't manually edited yet.
 *
 * Per-pipeline auto-update (t2i): when `pipeline` changes, server-driven
 * `pipeline_steps` sets steps, and `pipeline_resolution` ([w,h]) sets width/
 * height plus the resolution picker key. Picking a resolution preset writes
 * both dimensions (and locks them); editing either dimension keeps the picker
 * in sync.
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
        if (k === "pipeline_steps" || k === "pipeline_resolution" || k === "self_tests") continue;
        if (!userModifiedRef.current.has(k)) next[k] = v;
      }
      // Auto-update steps when pipeline changes (if user hasn't manually set steps)
      if (serverDefaults.pipeline_steps && !userModifiedRef.current.has("steps")) {
        const ps = serverDefaults.pipeline_steps[next.pipeline ?? "zimage"];
        if (ps !== undefined) next.steps = ps;
      }
      // Auto-update resolution picker + width/height for the current pipeline.
      const resWH = serverDefaults.pipeline_resolution?.[next.pipeline ?? "zimage"];
      if (resWH && !userModifiedRef.current.has("width") && !userModifiedRef.current.has("height")) {
        next.width = resWH[0];
        next.height = resWH[1];
        const rk = resolutionKey(resWH[0], resWH[1]);
        if (rk && !userModifiedRef.current.has("resolution")) next.resolution = rk;
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
      // When pipeline changes, auto-update width/height + resolution picker
      // (per-pipeline preference) unless the user has edited either dimension.
      if (key === "pipeline") {
        const resWH = serverDefaults?.pipeline_resolution?.[value];
        if (resWH && !userModifiedRef.current.has("width") && !userModifiedRef.current.has("height")) {
          next.width = resWH[0];
          next.height = resWH[1];
          const rk = resolutionKey(resWH[0], resWH[1]);
          if (rk && !userModifiedRef.current.has("resolution")) next.resolution = rk;
        }
      }
      // Picking a resolution preset sets width/height and locks them (a later
      // pipeline switch won't override the user's explicit choice).
      if (key === "resolution") {
        const wh = RESOLUTION_MAP[value];
        if (wh) {
          next.width = wh[0];
          next.height = wh[1];
          userModifiedRef.current.add("width");
          userModifiedRef.current.add("height");
        }
      }
      // Editing width/height directly keeps the resolution picker in sync.
      if (key === "width" || key === "height") {
        const rk = resolutionKey(next.width, next.height);
        if (rk) next.resolution = rk;
      }
      return next;
    });
  };

  return { state, setField, serverDefaults };
}
