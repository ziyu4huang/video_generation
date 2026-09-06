/**
 * `/agents` viewer — CC-parity definition-management surface, ticket 01 of the
 * agents-manager effort (READ-ONLY slice): the registered agentType list
 * grouped by source (project → user → pack → builtin — the registry's own
 * precedence order), a detail pane per definition, and cursor navigation.
 *
 * Deliberately STATIC: definitions don't change while the dialog is open (no
 * live registry subscription exists), so there is no refresh timer — the
 * `hasLiveContent()` rule from the /subagents viewer collapses to `false`,
 * which is why this class doesn't even expose it.
 *
 * t02 will add create/edit/delete over the SAME list (core-runtime write path
 * D3); this class is shaped so those actions can re-load the registry and
 * invalidate without a remount.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentDefinition, AgentRegistry } from "@repo/s2-agent-core-runtime";

/** Section headers in the registry's own precedence order (agent-registry.ts:
 *  project > pack > user > builtin — the display order mirrors it so the top
 *  of the list is what wins a name collision). */
const SOURCE_ORDER = ["project", "pack", "user", "builtin"] as const;
type Source = (typeof SOURCE_ORDER)[number];

const SOURCE_LABEL: Partial<Record<Source, string>> = {
  project: "·  .pi/agents of this workspace",
  user: "·  ~/.pi/agents",
  pack: "·  extension pack",
  builtin: "·  core built-ins (read-only)",
};
// (t02 note: the editable-source predicate — project/user writable,
// builtin/pack view-only — lands WITH its CRUD consumer; shipping it ahead
// of any caller trips the dead-export guard, which is correct.)

/** One row's plain-text summary (no cursor/selection prefix — the caller owns
 *  the line assembly so the width math stays in one place). */
function rowBody(def: AgentDefinition, theme: Theme, width: number): string {
  const segs: string[] = [theme.fg("accent", def.name)];
  if (def.description) segs.push(theme.fg("muted", def.description));
  const model = def.model ?? (def.tier ? `tier:${def.tier}` : undefined);
  if (model) segs.push(theme.fg("muted", model));
  if (def.tools?.length) segs.push(theme.fg("dim", `${def.tools.length} tool${def.tools.length === 1 ? "" : "s"}`));
  if (def.disallowedTools?.length) {
    segs.push(theme.fg("dim", `−${def.disallowedTools.length}`));
  }
  if (def.isolation === "worktree") segs.push(theme.fg("dim", "⎇ worktree"));
  return truncateToWidth(segs.join("  ·  "), Math.max(0, width - 4));
}

/** The detail pane for one definition — every frontmatter field plus the
 *  prompt body, each line width-capped (render-layer safe: tolerates partial
 *  definitions, an uncaught render throw kills the whole host TUI). */
function detailLines(def: AgentDefinition, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  const field = (label: string, value: string | undefined): void => {
    lines.push(truncateToWidth(`  ${theme.fg("dim", `${label}:`)} ${value ?? "—"}`, width));
  };
  field("name", def.name);
  field("source", def.source);
  field("description", def.description);
  field("model", def.model);
  field("tier", def.tier);
  field("tools", def.tools?.join(", "));
  field("disallowedTools", def.disallowedTools?.join(", "));
  field("isolation", def.isolation);
  lines.push("");
  lines.push(truncateToWidth(`  ${theme.fg("dim", "prompt:")}`, width));
  const body = def.prompt ?? "";
  for (const raw of body.split("\n")) {
    lines.push(truncateToWidth(`  ${theme.fg("toolOutput", raw)}`, width));
  }
  if (!body.trim()) lines.push(truncateToWidth(`  ${theme.fg("dim", "(empty)")}`, width));
  return lines;
}

export interface AgentsViewerOpts {
  registry: AgentRegistry;
  onClose: () => void;
}

/** Stateful list ↔ detail viewer. Static content: render() caches per width. */
export class AgentsViewer {
  private readonly registry: AgentRegistry;
  private readonly onClose: () => void;
  /** Flat cursor order: grouped by SOURCE_ORDER, names A→Z inside a group. */
  private order: AgentDefinition[] = [];
  private selected = 0;
  private view: "list" | "detail" = "list";
  private detailName?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly theme: Theme;

  constructor(opts: AgentsViewerOpts, theme: Theme) {
    this.registry = opts.registry;
    this.onClose = opts.onClose;
    this.theme = theme;
    this.rebuild();
  }

  /** Rebuild the flat cursor order from the registry (t02 calls this after a
   *  CRUD action + invalidate instead of remounting the dialog). */
  private rebuild(): void {
    const bySource = new Map<Source, AgentDefinition[]>();
    for (const def of this.registry.values()) {
      const src = (SOURCE_ORDER as readonly string[]).includes(def.source) ? (def.source as Source) : "builtin";
      const bucket = bySource.get(src) ?? [];
      bucket.push(def);
      bySource.set(src, bucket);
    }
    this.order = [];
    for (const src of SOURCE_ORDER) {
      const bucket = bySource.get(src) ?? [];
      bucket.sort((a, b) => a.name.localeCompare(b.name));
      this.order.push(...bucket);
    }
    if (this.selected > this.order.length - 1) this.selected = Math.max(0, this.order.length - 1);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view === "detail") {
        this.view = "list";
        this.invalidate();
      } else {
        this.onClose();
      }
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      if (this.selected > 0) this.selected -= 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      if (this.selected < this.order.length - 1) this.selected += 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.view === "list") {
        const def = this.order[this.selected];
        if (def) {
          this.detailName = def.name;
          this.view = "detail";
        }
      } else {
        this.view = "list";
      }
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedLines = this.view === "detail" ? this.renderDetail(width) : this.renderList(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private renderList(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [""];
    lines.push(
      truncateToWidth(
        `${th.fg("accent", th.bold(" Agent types "))}${th.fg("borderMuted", "─".repeat(Math.max(0, width - 13)))}`,
        width,
      ),
    );
    lines.push("");
    if (this.order.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No agentTypes registered.")}`, width));
    }
    let lastSource = "";
    for (let i = 0; i < this.order.length; i++) {
      const def = this.order[i];
      if (!def) continue;
      if (def.source !== lastSource) {
        lastSource = def.source;
        const src = (SOURCE_ORDER as readonly string[]).includes(def.source) ? (def.source as Source) : "builtin";
        lines.push("");
        lines.push(
          truncateToWidth(`  ${th.fg("accent", th.bold(src))} ${th.fg("dim", SOURCE_LABEL[src] ?? "")}`, width),
        );
      }
      const cur = i === this.selected;
      const cursor = cur ? th.bg("selectedBg", "▶ ") : "  ";
      lines.push(truncateToWidth(`  ${cursor}${rowBody(def, th, width)}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓/j k select • enter detail • esc close")}`, width));
    lines.push("");
    return lines;
  }

  private renderDetail(width: number): string[] {
    const th = this.theme;
    const def = this.detailName ? this.registry.get(this.detailName) : undefined;
    const lines: string[] = [""];
    if (!def) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "definition not found")}`, width));
    } else {
      lines.push(
        truncateToWidth(`${th.fg("accent", th.bold(` ${def.name} `))}${th.fg("dim", `  ${def.source}`)}`, width),
      );
      lines.push("");
      lines.push(...detailLines(def, th, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "esc back to list")}`, width));
    lines.push("");
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
