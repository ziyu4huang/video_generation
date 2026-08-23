/**
 * `cron_create` / `cron_list` / `cron_delete` (ticket 08): schedule a saved
 * workflow or pack to fire on a 5-field cron expression while a session is
 * live. Definitions are durable; firing is session-live only (map D8) and
 * lease-claimed per due minute so two concurrent live sessions never
 * double-fire the same slot.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CronFields, nextFire, parseCronExpression } from "./cron-scheduler.js";
import type { CronDefinition, CronStore } from "./cron-store.js";

const cronCreateSchema = Type.Object({
  cron: Type.String({
    description:
      '5-field cron expression in LOCAL time: "minute hour day-of-month month day-of-week" (e.g. "*/15 * * * *", "0 9 * * 1-5"). No timezone math.',
  }),
  workflow: Type.String({
    description:
      "Workflow to fire: a saved-workflow/pack name or a path (same resolution as the workflow tool's name).",
  }),
  kind: Type.Optional(
    StringEnum(["one-shot", "recurring"] as const, {
      description:
        "one-shot fires once then auto-deletes; recurring fires on every match and auto-expires 7 days after creation. Default recurring.",
    }),
  ),
  name: Type.Optional(Type.String({ description: "Optional human label; defaults to the workflow name." })),
  args: Type.Optional(Type.Unknown({ description: "Args passed to the fired workflow run." })),
});

const cronListSchema = Type.Object({});

const cronDeleteSchema = Type.Object({
  id: Type.String({ description: "The schedule id from cron_list / cron_create." }),
});

export interface CronToolsOptions {
  store: CronStore;
  /** Resolves a workflow name to script text — used to validate at create time. */
  resolveScript: (workflow: string) => string | null;
  /** Injectable clock for deterministic next-fire previews (tests). */
  now?: () => Date;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function renderDefinition(def: CronDefinition, now: () => Date): string {
  let next = "<never>";
  try {
    const due = nextFire(parseCronExpression(def.cron), new Date(def.lastFiredAt ?? def.createdAt));
    if (due) {
      const expired = def.expiresAt && Date.parse(def.expiresAt) <= now().getTime();
      next = expired ? "<expired>" : due.toLocaleString();
    }
  } catch {
    next = "<invalid expression>";
  }
  const bits = [
    `id: ${def.id}`,
    `name: ${def.name}`,
    `cron: ${def.cron} (local time)`,
    `kind: ${def.kind}`,
    `workflow: ${def.workflow}`,
    `next fire: ${next}`,
    `fired: ${def.firedCount}`,
  ];
  if (def.expiresAt) bits.push(`expires: ${def.expiresAt}`);
  return bits.join("\n");
}

export function createCronTools(options: CronToolsOptions): ToolDefinition[] {
  const { store, resolveScript, now = () => new Date() } = options;

  const cronCreateTool: ToolDefinition<typeof cronCreateSchema, undefined> = defineTool({
    name: "cron_create",
    label: "CronCreate",
    description:
      "Schedule a workflow to fire on a 5-field cron expression (local time). One-shot fires once then deletes itself; recurring fires on every match and auto-expires after 7 days. Firing happens only while a session is live — no daemon. A fired run's budget comes from the workflow tool call inside the script — user '+500k'-style budget directives bind only the interactive message that armed them, never a cron fire.",
    // Owner-declared gating — joins the shared workflow family gate (see
    // GATE_DEFS["workflow"] in extensions/ultracode.ts); co-fires with
    // run_workflow / workflow_help / workflow_control.
    gating: { gate: "workflow" },
    promptSnippet: "Schedule a workflow on a cron schedule: cron_create({ cron, workflow, kind, args }).",
    parameters: cronCreateSchema,
    async execute(_toolCallId, params) {
      let fields: CronFields | undefined;
      try {
        fields = parseCronExpression(params.cron);
      } catch (err) {
        return textResult(`Invalid cron expression "${params.cron}": ${(err as Error).message}`);
      }
      if (resolveScript(params.workflow) == null) {
        return textResult(
          `Workflow "${params.workflow}" could not be resolved (neither a pack/saved-workflow name nor a path). Create or save it first.`,
        );
      }
      const preview = nextFire(fields, now());
      if (!preview) {
        return textResult(
          `Cron expression "${params.cron}" never fires (an impossible date, e.g. day-of-month 31 in February).`,
        );
      }
      const def = store.create({
        cron: params.cron,
        workflow: params.workflow,
        kind: params.kind ?? "recurring",
        name: params.name,
        args: params.args,
      });
      return textResult(
        [
          `Scheduled${def.kind === "one-shot" ? " (one-shot — deletes itself after firing)" : " (recurring — auto-expires 7 days after creation)"}.`,
          renderDefinition(def, now),
          "Firing is session-live only: a slot fires when a live session's 30 s scheduler pass sees it due; missed slots are skipped, not replayed.",
        ].join("\n"),
      );
    },
  });

  const cronListTool: ToolDefinition<typeof cronListSchema, undefined> = defineTool({
    name: "cron_list",
    label: "CronList",
    description: "List scheduled workflow cron definitions (id, expression, next fire, expiry).",
    gating: { gate: "workflow" },
    promptSnippet: "List cron schedules: cron_list().",
    parameters: cronListSchema,
    async execute() {
      const defs = store.list();
      if (!defs.length) return textResult("No cron schedules. Create one with cron_create.");
      return textResult(defs.map((d) => renderDefinition(d, now)).join("\n\n"));
    },
  });

  const cronDeleteTool: ToolDefinition<typeof cronDeleteSchema, undefined> = defineTool({
    name: "cron_delete",
    label: "CronDelete",
    description: "Delete a scheduled workflow cron definition by id.",
    gating: { gate: "workflow" },
    promptSnippet: "Delete a cron schedule: cron_delete({ id }).",
    parameters: cronDeleteSchema,
    async execute(_toolCallId, params) {
      return store.delete(params.id)
        ? textResult(`Deleted schedule ${params.id}.`)
        : textResult(`No cron schedule "${params.id}". Use cron_list to see ids.`);
    },
  });

  // ToolDefinition is invariant in its schema parameter, so the per-tool
  // precise generics can't widen to the array element type without a cast —
  // the registration path treats definitions opaquely anyway.
  return [cronCreateTool, cronListTool, cronDeleteTool] as unknown as ToolDefinition[];
}
