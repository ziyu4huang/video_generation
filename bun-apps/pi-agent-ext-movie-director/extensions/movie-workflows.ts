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
 *
 * The 4 scripts are statically imported as text (Bun's `with { type: "text" }`
 * loader) rather than read via readFileSync(import.meta.url-relative path) —
 * the latter breaks once this extension is bundled for deploy (thin or full):
 * the bundle lands under dist/pi-ext-bundles/ with no sibling workflows/ dir,
 * so a runtime-relative read throws ENOENT. A statically-analyzable import
 * gets its content inlined into the bundle by the bundler, so it survives.
 */
import sceneAssetsSrc from "../workflows/scene-assets/index.js" with { type: "text" };
import researchFirstSrc from "../workflows/research-first/index.js" with { type: "text" };
import reviewCutSrc from "../workflows/review-cut/index.js" with { type: "text" };
import produceVideoSrc from "../workflows/produce-video/index.js" with { type: "text" };
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMovieManager, type MovieManagerFactory } from "../src/movie-manager.ts";

interface WfDef {
  name: string;
  desc: string;
  source: string;
}

const WORKFLOWS: WfDef[] = [
  { name: "scene-assets", desc: "Parallel T2I→I2V→TTS asset generation per scene", source: sceneAssetsSrc },
  { name: "research-first", desc: "Web research + cross-check → proposal_packet", source: researchFirstSrc },
  { name: "review-cut", desc: "Adversarial review of a composed cut vs the script", source: reviewCutSrc },
  { name: "produce-video", desc: "Full movie pipeline (idea→publish) as a resumable workflow", source: produceVideoSrc },
];

/** Every workflow script's source, keyed by name (for loadSavedWorkflow). */
function loadAllScripts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const wf of WORKFLOWS) {
    out[wf.name] = wf.source;
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
    // getCommands() throws "Extension runtime not initialized" when called
    // during extension loading (before Runner.bindCore() swaps in the real
    // implementation) — which is exactly when this factory normally runs.
    // Treat that as "not taken" (registerCommand itself is a Map.set(), so a
    // genuine duplicate is a harmless overwrite, not a crash).
    let taken = false;
    try {
      taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === wf.name);
    } catch {
      taken = false;
    }
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
