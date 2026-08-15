/**
 * present-tool.ts — the LLM-callable BLOCKING HITL gate (spec Component 2).
 *
 * `createPresentTool(deps)` builds the `webui_present` ToolDefinition. Its
 * execute() presents content + declarative controls to the browser (via the
 * `present` dep → the `webui:present` event → the present-as-view registry),
 * then BLOCKS on the pending-Promise registry keyed by the generated
 * `present_<now>_<seq>` id until the browser posts an appexec respond (Phase-1
 * return transport) or an abort fires (session_shutdown / WS close resolve all
 * pending; the tool's own `signal` cancels just this one via `cancelPending`).
 *
 * Deliberately a FACTORY over explicit deps so the
 * blocking/guard/abort logic is unit-testable with fakes — no live wiring, no
 * Bun.serve. The error path returns a tool RESULT (text + `details.error`),
 * mirroring ask-user's local envelope style — NEVER a thrown crash. No
 * cross-package import: the webui package has zero today and gains none.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Control, RenderMode } from "./render-service.js";
import type { HitlResponse } from "./webui-wiring.js";

export const PresentParameters = Type.Object({
  content: Type.String({ description: "Markdown or HTML to present to the user." }),
  mode: Type.Optional(
    StringEnum(["md", "html"] as const, {
      description: "Render mode. Default 'md'.",
    })
  ),
  view: Type.Optional(Type.String({ description: "Named view id. Default 'present'." })),
  title: Type.Optional(Type.String({ description: "Optional presentation title shown in the shell." })),
  controls: Type.Array(
    Type.Object({
      id: Type.String({ description: "Control id — returned to you as the response `action`." }),
      label: Type.String({ description: "Button label shown to the user." }),
      takesInput: Type.Optional(
        Type.Boolean({ description: "If true, a free-text tweak input is revealed next to this control." })
      ),
    }),
    { minItems: 1, description: "Declarative response controls (the user picks exactly one)." }
  ),
});

/** What the tool hands its `present` dep; `id` is the tool-generated presentId. */
export interface PresentInput {
  content: string;
  controls: Control[];
  id: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
}

/** Mints the presentation (view + event) and returns the presentId. */
export type PresentFn = (input: PresentInput) => string;

export interface PresentToolDeps {
  present: PresentFn;
  registerPending: (id: string) => Promise<HitlResponse>;
  hasPending: () => boolean;
  cancelPending: (id: string) => void;
}

export interface PresentToolDetails {
  action?: string;
  tweak?: string;
  cancelled?: boolean;
  error?: string;
}

const ERROR_ALREADY_PENDING =
  "Another webui_present is already pending (one presentation at a time in v1). " +
  "Wait for the user to respond to it — or for it to be cancelled — before presenting again.";

/** Module-level sequence so ids are unique within a process. */
let presentSeq = 0;
function nextPresentId(): string {
  presentSeq += 1;
  return `present_${Date.now()}_${presentSeq}`;
}

/** Human-readable one-liner for the tool result text (structured data rides `details`). */
export function describeHitlResponse(r: HitlResponse): string {
  if ("cancelled" in r) return "User cancelled / connection lost.";
  if (r.tweak !== undefined) return `User requested ${r.action} with tweak: "${r.tweak}".`;
  if (r.action === "approve") return "User approved (action: approve).";
  return `User chose action "${r.action}".`;
}

/**
 * Await the pending response, wiring the tool's abort signal: on abort, cancel
 * THIS pending (cancelPending resolves it as {cancelled:true}, so the outer
 * promise settles normally). No timeout — loopback HITL blocks indefinitely
 * until response or abort (spec).
 *
 * v2 (architecture v2 §3.5): an ALREADY-ABORTED signal must not hang the
 * execute() — a signal that aborted before we attached the listener would
 * never fire it, so the pending would block forever. Check signal.aborted
 * first and resolve {cancelled:true} immediately (cancelling the pending so
 * the registry does not leak).
 */
function awaitPendingWithAbort(
  p: Promise<HitlResponse>,
  signal: AbortSignal | undefined,
  onCancel: () => void
): Promise<HitlResponse> {
  if (!signal) return p;
  if (signal.aborted) {
    onCancel();
    return Promise.resolve({ cancelled: true });
  }
  return new Promise<HitlResponse>((resolve) => {
    const onAbort = () => onCancel();
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then((r) => {
      signal.removeEventListener("abort", onAbort);
      resolve(r);
    });
  });
}

export function createPresentTool(
  deps: PresentToolDeps
): ToolDefinition<typeof PresentParameters, PresentToolDetails> {
  return {
    name: "webui_present",
    label: "Present",
    description:
      "Present content (markdown or HTML, e.g. a generated image as markdown) to the user in the " +
      "browser TOGETHER with declarative response controls, and BLOCK until the user picks one. " +
      "Each control is a button ({id, label}); controls with takesInput reveal a free-text tweak " +
      "field. Returns {action: <controlId>, tweak?} when the user responds, or {cancelled: true} " +
      "if the user cancels / the connection drops. One presentation at a time. To present " +
      "generated images, reference them as ![image](/output/0/<name>) markdown — images live " +
      "under the MLX output dir and are served at /output/ (subpaths preserved, e.g. " +
      "![image](/output/0/profile_TS/front.png)).",
    promptSnippet:
      "Use to show the user content and WAIT for their decision via declarative controls (blocking HITL gate). " +
      "Present generated images as ![image](/output/0/<name>) markdown.",
    parameters: PresentParameters,
    async execute(_callId, params, signal, _onUpdate, _ctx) {
      // One-pending-at-a-time guard (spec: v1) — an error RESULT, not a crash.
      if (deps.hasPending()) {
        return {
          content: [{ type: "text", text: ERROR_ALREADY_PENDING }],
          details: { error: "already_pending" },
        };
      }
      const id = nextPresentId();
      const presentId = deps.present({
        content: params.content,
        controls: params.controls,
        id,
        ...(params.mode !== undefined ? { mode: params.mode as RenderMode } : {}),
        ...(params.view !== undefined ? { view: params.view } : {}),
        ...(params.title !== undefined ? { title: params.title } : {}),
      });
      const response = await awaitPendingWithAbort(
        deps.registerPending(presentId),
        signal,
        () => deps.cancelPending(presentId)
      );
      // Branch on `cancelled` BEFORE reading `action` (Phase-2 ledger: the
      // HitlResponse union makes this the only narrowing path).
      if ("cancelled" in response) {
        return {
          content: [{ type: "text", text: "User cancelled / connection lost." }],
          details: { cancelled: true },
        };
      }
      return {
        content: [{ type: "text", text: describeHitlResponse(response) }],
        details:
          response.tweak !== undefined
            ? { action: response.action, tweak: response.tweak }
            : { action: response.action },
      };
    },
  };
}
