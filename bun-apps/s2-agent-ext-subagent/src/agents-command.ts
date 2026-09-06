/**
 * `/agents` command — the CC-parity agentType management entry (ticket 01:
 * read-only list + detail). Self-contained like `/subagents`: the factory
 * takes nothing (the registry loads from the session cwd at open time) and
 * the viewer is static, so there is no refresh timer to manage.
 */

import { loadAgentRegistry } from "@repo/s2-agent-core-runtime";
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
    description: "View agentType definitions (project / user / pack / builtin) and their prompts",
    handler: async (_args, ctx) => {
      const c = ctx as AgentsCommandCtx;
      if (c.mode !== "tui") {
        c.ui.notify("/agents requires interactive mode", "error");
        return;
      }
      const registry = loadAgentRegistry(opts?.cwd ?? process.cwd());
      await c.ui.custom<void>((tui, theme, _kb, done) => {
        const viewer = new AgentsViewer({ registry, onClose: done }, theme as never);
        return {
          render: (w: number) => viewer.render(w),
          invalidate: () => viewer.invalidate(),
          // requestRender after every input — a static viewer normally only
          // needs it on invalidate(), but mirroring /subagents keeps the two
          // dialogs' input contract identical for t02's CRUD additions.
          handleInput: (data: string) => {
            viewer.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  };
}
