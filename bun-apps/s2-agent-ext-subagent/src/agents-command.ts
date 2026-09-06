/**
 * `/agents` command — the CC-parity agentType management entry. Ticket 01 was
 * the read-only list + detail; ticket 02 wires the CRUD layer: the command
 * computes the writable dirs (project `.pi/agents`, user `~/.pi/agents`) and
 * hands the viewer an onReload that re-runs loadAgentRegistry after every
 * successful create/edit/delete.
 */

import { join } from "node:path";
import { AGENTS_DIR, homeDir, loadAgentRegistry } from "@repo/s2-agent-core-runtime";
import { AgentsViewer } from "./agents-viewer.js";

/** Minimal slice of the pi host command context this command depends on
 *  (mirrors SubagentsCommandCtx minus the session branch — the registry is
 *  filesystem-sourced, not transcript-sourced). */
export interface AgentsCommandCtx {
  mode: string;
  ui: {
    notify: (message: string, kind: string) => void;
    custom: <T>(
      factory: (
        tui: { requestRender: () => void },
        theme: unknown,
        kb: unknown,
        done: () => void,
      ) => {
        render: (width: number) => string[];
        invalidate: () => void;
        handleInput: (data: string) => void;
      },
    ) => Promise<T>;
  };
}

export interface AgentsCommand {
  description: string;
  handler: (args: unknown, ctx: unknown) => Promise<void>;
}

export function createAgentsCommand(opts?: { cwd?: string }): AgentsCommand {
  return {
    // Same vocabulary as /subagents' description ("View ..." style), now that
    // the dialog manages as well as views.
    description: "Manage agentType definitions — view, create, edit, delete (builtin/pack view-only)",
    handler: async (_args, ctx) => {
      const c = ctx as AgentsCommandCtx;
      if (c.mode !== "tui") {
        c.ui.notify("/agents requires interactive mode", "error");
        return;
      }
      const cwd = opts?.cwd ?? process.cwd();
      const packDirs: string[] = [];
      const load = (): ReturnType<typeof loadAgentRegistry> => loadAgentRegistry(cwd, { packDirs });
      const registry = load();
      await c.ui.custom<void>((tui, theme, _kb, done) => {
        const viewer = new AgentsViewer(
          {
            registry,
            onClose: done,
            dirs: { project: join(cwd, AGENTS_DIR), user: join(homeDir(), AGENTS_DIR), packDirs },
            onReload: load,
          },
          theme as never,
        );
        return {
          render: (w: number) => viewer.render(w),
          invalidate: () => viewer.invalidate(),
          // requestRender after every input — a static viewer normally only
          // needs it on invalidate(), but mirroring /subagents keeps the two
          // dialogs' input contract identical.
          handleInput: (data: string) => {
            viewer.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  };
}
