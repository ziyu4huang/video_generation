/**
 * movie-workflows.ts — register the movie-director saved workflows as slash
 * commands (`/produce-video`, `/scene-assets`, `/research-first`, `/review-cut`).
 *
 * Each command handler reads its workflow `.js` and runs it via workflow's public
 * runWorkflow, passing:
 *   • hostFns: buildMovieHostFnRegistry()  — the explicit duck-typed registry
 *     (Phase-1 spike: runWorkflow does NOT auto-wire the event bus; the bus
 *      registration in movie-host-fns.ts only serves workflow-EXTENSION runs).
 *   • loadSavedWorkflow: name → script  — so /produce-video's nested
 *     workflow('research-first'|'scene-assets'|'review-cut', …) calls resolve
 *     to the sibling scripts without each being a separately-saved workflow.
 *
 * Grows one entry per workflow phase (Phases 3-6). Add to WORKFLOWS and the
 * shared machinery applies.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { runWorkflow, createWebTools } from "@repo/pi-agent-ext-workflow";
import { buildMovieHostFnRegistry } from "../src/host-fns.ts";

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

export function registerMovieWorkflows(pi: ExtensionAPI, cwd: string): void {
  // Defensive: no-op on hosts that don't provide registerCommand (test mocks,
  // older pi versions). Mirrors registerMovieHostFns' pi.events guard.
  if (typeof pi.registerCommand !== "function") return;
  const scripts = loadAllScripts();

  for (const wf of WORKFLOWS) {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === wf.name);
    if (taken) continue;
    const script = scripts[wf.name];
    pi.registerCommand(wf.name, {
      description: wf.desc,
      async handler(args: string, ctx: ExtensionCommandContext) {
        ctx.ui.notify(`Running /${wf.name}…`, "info");
        try {
          const result = await runWorkflow(script, {
            cwd,
            args: args.trim(),
            // Explicit host-fn registry (spike): call('movie.*') resolves here.
            hostFns: buildMovieHostFnRegistry(),
            // Nested workflow() calls (e.g. /produce-video → /scene-assets) resolve
            // to the sibling scripts loaded above.
            loadSavedWorkflow: (name: string) => scripts[name],
            // Coding tools (Bash/Read/…) + web tools (web_search) so /research-first
            // agents can actually research; harmless for the other workflows.
            tools: [...createCodingTools(cwd), ...createWebTools()],
            onLog: (m: string) => ctx.ui.setStatus(wf.name, m.slice(0, 80)),
            onPhase: (title: string) => ctx.ui.setStatus(wf.name, title),
          });
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
