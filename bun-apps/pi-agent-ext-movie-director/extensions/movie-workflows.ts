/**
 * movie-workflows.ts — register the movie-director saved workflows as slash
 * commands (`/produce-video`, `/scene-assets`, `/research-first`, `/review-cut`).
 *
 * Each command handler runs its workflow `.js` through a WorkflowManager
 * (`createMovieManager`), NOT bare runWorkflow. The manager is what makes the
 * run crash-resumable: it persists the journal (onAgentJournal → save),
 * reconciles a process that died mid-run (recoverStaleRuns: "running" →
 * "paused"), and exposes resume(runId) — so a `/produce-video` killed mid-assets
 * can be replayed+finished via `/workflows resume <runId>` (auto-detected as
 * resumable on the next session start).
 *
 * Options:
 *   • loadSavedWorkflow — name → script, so /produce-video's nested
 *     workflow('research-first'|'scene-assets'|'review-cut', …) calls resolve
 *     to the sibling scripts without each being a separately-saved workflow.
 *   • managerFactory — test injection; defaults to createMovieManager.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMovieManager, type MovieManagerFactory } from "../src/movie-manager.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "workflows");

interface WfDef {
  name: string;
  desc: string;
  file: string;
}

const WORKFLOWS: WfDef[] = [
  { name: "scene-assets", desc: "Parallel T2I→I2V→TTS asset generation per scene", file: "scene-assets.js" },
  { name: "research-first", desc: "Web research + cross-check → proposal_packet", file: "research-first.js" },
  { name: "review-cut", desc: "Adversarial review of a composed cut vs the script", file: "review-cut.js" },
  { name: "produce-video", desc: "Full movie pipeline (idea→publish) as a resumable workflow", file: "produce-video.js" },
];

/** Read every workflow script into a name→source map (for loadSavedWorkflow). */
function loadAllScripts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const wf of WORKFLOWS) {
    out[wf.name] = readFileSync(join(WORKFLOWS_DIR, wf.file), "utf8");
  }
  return out;
}

export function registerMovieWorkflows(
  pi: ExtensionAPI,
  cwd: string,
  opts: { managerFactory?: MovieManagerFactory } = {},
): void {
  // Defensive: no-op on hosts that don't provide registerCommand (test mocks,
  // older pi versions). Mirrors registerMovieHostFns' pi.events guard.
  if (typeof pi.registerCommand !== "function") return;
  const scripts = loadAllScripts();
  const factory = opts.managerFactory ?? createMovieManager;

  for (const wf of WORKFLOWS) {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === wf.name);
    if (taken) continue;
    const script = scripts[wf.name];
    if (script === undefined) continue; // script file missing/failed to load — nothing to register
    pi.registerCommand(wf.name, {
      description: wf.desc,
      async handler(args: string, ctx: ExtensionCommandContext) {
        ctx.ui.notify(`Running /${wf.name}…`, "info");
        // Fresh manager per invocation: durable journal + recoverStaleRuns +
        // resume, with no cross-invocation listener accumulation.
        const mgr = factory(cwd, { loadSavedWorkflow: (name: string) => scripts[name] });
        mgr.on("log", (p: { message: string }) => ctx.ui.setStatus(wf.name, p.message.slice(0, 80)));
        mgr.on("phase", (p: { title: string }) => ctx.ui.setStatus(wf.name, p.title));
        try {
          const result = await mgr.runSync(script, args.trim());
          ctx.ui.setStatus(wf.name, undefined);
          const text =
            typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
          await pi.sendMessage({ customType: wf.name, content: text, display: true });
        } catch (error) {
          ctx.ui.setStatus(wf.name, undefined);
          ctx.ui.notify(`/${wf.name} failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }
}
