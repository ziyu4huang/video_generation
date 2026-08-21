import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportHeader } from "../report.js";

/**
 * inspect_tui — debug the above-editor widget state (the ● Todos (N/M)
 * banner and friends). Reads the globalThis-backed CoreTaskStatusWidget
 * singleton that s2-agent-ext-task publishes, calls its inspect() to get
 * a JSON snapshot of widget registration, section list, rendered output, and
 * per-section detail (e.g. the todo overlay's hidden-task state).
 *
 * Why globalThis: pi's ExtensionUIContext is WRITE-ONLY for widgets
 * (setWidget exists, no getWidget). The composite widget sidesteps this by
 * being a process-singleton on globalThis — so a diagnostic tool in a
 * DIFFERENT extension package (this one) can read it without an SDK API.
 */
export function makeInspectTuiTool() {
  return defineTool({
    name: "inspect_tui",
    gating: { core: true }, // un-gated (ticket 06 HITL): diagnostics always-on
    label: "Inspect TUI",
    description:
      "Debug the above-editor widget state — the composite status widget (goal +" +
      " todo + wayfind sections), what it renders right now, and the todo overlay's" +
      " hidden/display state (completed tasks auto-hidden from previous turns)." +
      " Use when a widget shows unexpected content or counts (e.g. Todos 0/2).",
    parameters: Type.Object({
      return_json: Type.Optional(
        Type.Boolean({ description: "Return machine-readable JSON snapshot instead of a text report" }),
      ),
      width: Type.Optional(
        Type.Number({ description: "Terminal width for the rendered-output preview (default 120)" }),
      ),
      self_test: Type.Optional(
        Type.Boolean({ description: "When true, return a deterministic mock report without a live session" }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.self_test) {
        return {
          content: [{
            type: "text" as const,
            text: [
              ...reportHeader("Inspect TUI"),
              'self_test: true',
              'Deterministic mock output — no live session required',
            ].join("\n"),
          }],
          details: null,
        };
      }

      const g = globalThis as Record<string, unknown>;
      const widget = g.__piCoreTaskStatusWidget as {
        inspect?: (width?: number) => {
          widgetKey: string;
          registered: boolean;
          sections: { id: string; order?: number; detail?: unknown }[];
          renderedLines: string[];
        };
      } | undefined;

      // ── Gather coordination seams ────────────────────────────────
      const goalActive = typeof g.__piGoalActive === "function" ? g.__piGoalActive() : undefined;
      const hasPlan = typeof g.__piPlanPhases === "function";
      const seams = {
        __piGoalActive: goalActive,
        __piPlanPhases: hasPlan ? "[available]" : "(not loaded)",
      };

      // ── Widget not loaded ────────────────────────────────────────
      if (!widget || typeof widget.inspect !== "function") {
        const lines = [
          ...reportHeader("Inspect TUI"),
          '▶ Composite status widget: NOT FOUND',
          '  globalThis.__piCoreTaskStatusWidget is absent or has no inspect().',
          '  Is s2-agent-ext-task loaded?',
          '',
          '▶ Coordination seams:',
        ];
        for (const [k, v] of Object.entries(seams)) {
          lines.push(`  ${k}: ${v}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: null };
      }

      const snapshot = widget.inspect(params.width ?? 120);

      if (params.return_json) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ widget: snapshot, seams }, null, 2) }],
          details: null,
        };
      }

      // ── Format text report ───────────────────────────────────────
      const lines = reportHeader("Inspect TUI");

      // Composite widget overview
      lines.push('▶ Composite status widget');
      lines.push(`  key: ${snapshot.widgetKey}`);
      lines.push(`  registered: ${snapshot.registered}`);
      lines.push(`  sections (${snapshot.sections.length}):`);
      for (const s of snapshot.sections) {
        const orderStr = s.order !== undefined ? `[${s.order}]` : "[?]";
        const hasDetail = s.detail != null ? " (inspectable)" : "";
        lines.push(`    ${orderStr} ${s.id}${hasDetail}`);
      }
      lines.push('');

      // Rendered output (ANSI stripped)
      lines.push(`▶ Rendered output (plain text, ${snapshot.renderedLines.length} lines):`);
      if (snapshot.renderedLines.length === 0) {
        lines.push('  (empty — no section produced output)');
      } else {
        for (const rl of snapshot.renderedLines) {
          lines.push(`  ${rl}`);
        }
      }
      lines.push('');

      // Per-section detail (todo overlay)
      const todoSection = snapshot.sections.find((s) => s.id === "todo");
      const todoDetail = todoSection?.detail as {
        totalTasks?: number;
        visibleTasks?: number;
        hiddenCompletedTaskIds?: number[];
        pendingHideIds?: number[];
        fullTaskList?: { id: number; subject: string; status: string }[];
      } | undefined;

      if (todoDetail) {
        lines.push('▶ Todo overlay detail:');
        const full = todoDetail.fullTaskList ?? [];
        const byStatus = (st: string) => full.filter((t) => t.status === st).length;
        lines.push(`  total: ${todoDetail.totalTasks ?? full.length} (${byStatus("pending")} pending, ${byStatus("in_progress")} in-progress, ${byStatus("completed")} completed)`);
        lines.push(`  visible: ${todoDetail.visibleTasks ?? "?"}`);
        const hidden = todoDetail.hiddenCompletedTaskIds ?? [];
        lines.push(`  hidden completed: ${hidden.length > 0 ? "#" + hidden.join(", #") : "(none)"}`);
        const pendingHide = todoDetail.pendingHideIds ?? [];
        lines.push(`  pending hide: ${pendingHide.length > 0 ? "#" + pendingHide.join(", #") : "(none)"}`);
        if (full.length > 0) {
          lines.push('  full task list:');
          for (const t of full) {
            const glyph = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : t.status === "deleted" ? "✗" : "○";
            const hiddenTag = hidden.includes(t.id) ? " (hidden)" : "";
            lines.push(`    ${glyph} #${t.id} ${t.subject}${hiddenTag}`);
          }
        }
        lines.push('');
      }

      // Coordination seams
      lines.push('▶ Coordination seams:');
      for (const [k, v] of Object.entries(seams)) {
        lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: null };
    },
  });
}
