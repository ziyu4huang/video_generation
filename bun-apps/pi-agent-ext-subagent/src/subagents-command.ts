/**
 * `/subagents` command — list running + past subagent runs and view their
 * output. Extracted from the extension entry so the host-integration wiring
 * (registry → viewer → live timer) is unit-testable without a live TUI.
 *
 * The handler accepts an opaque `ctx` (typed `unknown`) and narrows it to
 * {@link SubagentsCommandCtx} internally. This sidesteps TS parameter-variance
 * friction against the host's broader command context while keeping the contract
 * explicit and testable.
 */

// Type-only import of the registry this extension owns (local — same package).
import type { SubagentInFlightRegistry } from "./index.js";
import { reconstructSubagentRuns, SubagentViewer } from "./subagent-viewer.js";

/** Minimal slice of the pi host command context this command depends on. */
export interface SubagentsCommandCtx {
  mode: string;
  ui: {
    notify: (message: string, kind: string) => void;
    custom: <T>(factory: SubagentsViewerFactory) => Promise<T>;
  };
  sessionManager?: { getBranch: () => unknown[] };
}

/** The factory pi's `ui.custom` invokes with TUI primitives. The host's `custom`
 *  is generic over its own resolve value; the factory itself does not depend on
 *  that type parameter, so it takes none. */
export type SubagentsViewerFactory = (
  tui: { requestRender: () => void },
  theme: unknown,
  kb: unknown,
  done: () => void,
) => {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
};

export interface SubagentsCommand {
  description: string;
  handler: (args: unknown, ctx: unknown) => Promise<void>;
}

/** Live re-render cadence for the Running section's elapsed counter (ms). */
const LIVE_RENDER_INTERVAL_MS = 1000;

/**
 * Build the `/subagents` command bound to an in-flight registry. The registry
 * is read live each render (via `getRunning`), so a running subagent shows up
 * the moment it is registered and its elapsed ticks while the viewer is open.
 */
export function createSubagentsCommand(opts: { subagentInFlight: SubagentInFlightRegistry }): SubagentsCommand {
  const { subagentInFlight } = opts;
  return {
    description: "List subagent runs (running + past) on this branch and view their output",
    handler: async (_args, ctx) => {
      const c = ctx as SubagentsCommandCtx;
      if (c.mode !== "tui") {
        c.ui.notify("/subagents requires interactive mode", "error");
        return;
      }
      const branch = (c.sessionManager?.getBranch() ?? []) as never;
      const runs = reconstructSubagentRuns(branch);
      await c.ui.custom<void>((tui, theme, _kb, done) => {
        let timer: ReturnType<typeof setInterval> | undefined;
        const viewer = new SubagentViewer(
          {
            runs,
            getRunning: () => subagentInFlight.list(),
            getRuns: () => reconstructSubagentRuns(branch),
            onClose: () => {
              if (timer) clearInterval(timer);
              done();
            },
            onAbort: (id) => subagentInFlight.abort(id),
          },
          theme as never,
        );
        // Live-elapsed: re-render every second ONLY when the current view has
        // live content (a `follow` trace, or a `list` with running entries).
        // Re-rendering a static completed-runs list every second caused the
        // replacement-UI flicker on "show all subagents".
        timer = setInterval(() => {
          if (!viewer.hasLiveContent()) return;
          viewer.invalidate();
          tui.requestRender();
        }, LIVE_RENDER_INTERVAL_MS);
        return {
          render: (w: number) => viewer.render(w),
          invalidate: () => viewer.invalidate(),
          handleInput: (data: string) => {
            viewer.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  };
}
