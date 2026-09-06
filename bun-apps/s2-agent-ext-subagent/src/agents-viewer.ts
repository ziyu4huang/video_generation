/**
 * `/agents` manager — CC-parity definition-management surface. Ticket 01 was
 * the read-only slice (grouped list + detail pane); ticket 02 adds the CRUD
 * layer over the SAME list: `c` create, `e` edit, `d` delete (y/N confirm).
 * Writes go through the core-runtime write path (`writeAgentDefinition` /
 * `deleteAgentDefinition`) against the project/user dirs; builtin/pack rows
 * are view-only by construction.
 *
 * Static between actions: definitions don't change while the dialog is open,
 * so there is no refresh timer — after each successful CRUD action the
 * `onReload` callback re-loads the registry and the view invalidates without
 * a remount.
 *
 * Render-layer safety rule: every fs/validation error is caught and rendered
 * inline (status line / form error row) — a throw here kills the whole host
 * TUI, so none of these paths can throw.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type AgentDefinition,
  type AgentDefinitionWrite,
  type AgentRegistry,
  deleteAgentDefinition,
  isValidAgentName,
  writeAgentDefinition,
} from "@repo/s2-agent-core-runtime";

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

/** Only files-backed, user-owned sources are writable. Builtin/pack rows stay
 *  view-only: their definitions come from code and extension packs. */
function isEditableSource(source: string): source is "project" | "user" {
  return source === "project" || source === "user";
}

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

/** The form's text fields, in tab order. The scope row is rendered after them
 *  and reached with the same keys (space toggles it). tools/disallowedTools
 *  take the comma-separated string form — the same canonical on-disk shape
 *  the serializer writes (ticket 14 / decision 09 round-trip). */
const FORM_FIELDS = ["name", "description", "model", "tier", "tools", "disallowedTools", "isolation"] as const;

interface FormState {
  mode: "create" | "edit";
  values: Record<(typeof FORM_FIELDS)[number], string>;
  scope: "project" | "user";
  /** Edit mode pins the scope to the definition's own source. */
  scopeLocked: boolean;
  active: number;
  originalName?: string;
  error?: string;
}

export interface AgentsViewerOpts {
  registry: AgentRegistry;
  onClose: () => void;
  /** Where create/edit/delete write. packDirs feeds the write path's
   *  pack-collision refusal (same dirs the registry was loaded with). */
  dirs: { project: string; user: string; packDirs: string[] };
  /** Re-load the registry after a successful CRUD action (command layer
   *  re-runs loadAgentRegistry). */
  onReload: () => AgentRegistry;
}

/** List ↔ detail ↔ form ↔ confirm manager. Static between actions. */
export class AgentsViewer {
  private registry: AgentRegistry;
  private readonly onClose: () => void;
  private readonly dirs: AgentsViewerOpts["dirs"];
  private readonly onReload: () => AgentRegistry;
  /** Flat cursor order: grouped by SOURCE_ORDER, names A→Z inside a group. */
  private order: AgentDefinition[] = [];
  private selected = 0;
  private view: "list" | "detail" | "form" | "confirm" = "list";
  private detailName?: string;
  private form?: FormState;
  private confirmName?: string;
  private status?: { text: string; kind: "info" | "error" };
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly theme: Theme;

  constructor(opts: AgentsViewerOpts, theme: Theme) {
    this.registry = opts.registry;
    this.onClose = opts.onClose;
    this.dirs = opts.dirs;
    this.onReload = opts.onReload;
    this.theme = theme;
    this.rebuild();
  }

  /** Rebuild the flat cursor order from the registry (after every CRUD action
   *  + invalidate, instead of remounting the dialog). */
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

  private selectedDef(): AgentDefinition | undefined {
    return this.order[this.selected];
  }

  private dirFor(scope: "project" | "user"): string {
    return scope === "project" ? this.dirs.project : this.dirs.user;
  }

  private reload(): void {
    this.registry = this.onReload();
    this.rebuild();
    this.invalidate();
  }

  private openCreateForm(): void {
    this.form = {
      mode: "create",
      values: { name: "", description: "", model: "", tier: "", tools: "", disallowedTools: "", isolation: "" },
      scope: "project",
      scopeLocked: false,
      active: 0,
    };
    this.view = "form";
    this.invalidate();
  }

  private openEditForm(def: AgentDefinition): void {
    if (!isEditableSource(def.source)) {
      this.status = { text: `${def.source} definitions are view-only`, kind: "error" };
      this.invalidate();
      return;
    }
    this.form = {
      mode: "edit",
      values: {
        name: def.name,
        description: def.description ?? "",
        model: def.model ?? "",
        tier: def.tier ?? "",
        tools: def.tools?.join(", ") ?? "",
        disallowedTools: def.disallowedTools?.join(", ") ?? "",
        isolation: def.isolation ?? "",
      },
      scope: def.source,
      scopeLocked: true,
      active: 0,
      originalName: def.name,
    };
    this.view = "form";
    this.invalidate();
  }

  /** Validate + persist the form. Returns without throwing — every failure
   *  lands in form.error (render-layer safety rule). */
  private submitForm(): void {
    const form = this.form;
    if (!form) return;
    form.error = undefined;
    const name = form.values.name.trim();
    if (!isValidAgentName(name)) {
      form.error = `invalid name "${name}" — kebab-case: a-z, 0-9, single dashes`;
      return;
    }
    if (form.values.isolation.trim() && form.values.isolation.trim() !== "worktree") {
      form.error = 'isolation must be empty or "worktree"';
      return;
    }
    const splitTools = (raw: string): string[] | undefined => {
      const arr = raw
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      return arr.length ? arr : undefined;
    };
    const write: AgentDefinitionWrite = {
      name,
      description: form.values.description.trim() || undefined,
      model: form.values.model.trim() || undefined,
      tier: form.values.tier.trim() || undefined,
      tools: splitTools(form.values.tools),
      disallowedTools: splitTools(form.values.disallowedTools),
      isolation: form.values.isolation.trim() === "worktree" ? "worktree" : undefined,
      // The form has no prompt editor (a one-line prompt form would be worse
      // than none): create starts an empty body the user fills in the file;
      // edit preserves the existing body verbatim — including across a rename.
      prompt: form.mode === "edit" ? (this.registry.get(form.originalName ?? "")?.prompt ?? "") : "",
    };

    // Registry-level refusals the core write path can't see: shadowing a
    // differently-sourced definition with the same name (first-wins would
    // make the new file a silent shadow — or be silently shadowed).
    const holder = this.registry.get(name);
    if (holder && !(form.mode === "edit" && form.originalName === name)) {
      if (!isEditableSource(holder.source)) {
        form.error = `"${name}" is a ${holder.source} definition — view-only`;
        return;
      }
      if (holder.source !== form.scope) {
        form.error = `"${name}" already exists in ${holder.source} scope — a ${form.scope} copy would shadow it`;
        return;
      }
    }

    try {
      const dir = this.dirFor(form.scope);
      const written = writeAgentDefinition(dir, write, { packDirs: this.dirs.packDirs });
      // Rename within the same scope: the old canonical file must go, or the
      // dir keeps a stale extra definition the registry scan would surface.
      if (form.mode === "edit" && form.originalName && form.originalName !== name) {
        try {
          deleteAgentDefinition(dir, form.originalName);
        } catch {
          // Old file already gone (or never existed) — the write still stands.
        }
      }
      this.status = { text: `saved ${written}`, kind: "info" };
      this.form = undefined;
      this.view = "list";
      this.reload();
    } catch (e) {
      form.error = e instanceof Error ? e.message : String(e);
    }
  }

  private deleteSelected(): void {
    const def = this.confirmName ? this.registry.get(this.confirmName) : undefined;
    if (!def || !isEditableSource(def.source)) {
      this.view = "list";
      this.invalidate();
      return;
    }
    try {
      const removed = deleteAgentDefinition(this.dirFor(def.source), def.name);
      this.status = { text: `deleted ${removed}`, kind: "info" };
    } catch (e) {
      this.status = { text: e instanceof Error ? e.message : String(e), kind: "error" };
    }
    this.confirmName = undefined;
    this.view = "list";
    this.reload();
  }

  handleInput(data: string): void {
    if (this.view === "form") {
      this.handleFormInput(data);
      return;
    }
    if (this.view === "confirm") {
      this.handleConfirmInput(data);
      return;
    }
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
        const def = this.selectedDef();
        if (def) {
          this.detailName = def.name;
          this.view = "detail";
        }
      } else {
        this.view = "list";
      }
      this.invalidate();
      return;
    }
    if (this.view === "list") {
      if (data === "c") {
        this.openCreateForm();
      } else if (data === "e") {
        const def = this.selectedDef();
        if (def) this.openEditForm(def);
      } else if (data === "d") {
        const def = this.selectedDef();
        if (!def) return;
        if (!isEditableSource(def.source)) {
          this.status = { text: `${def.source} definitions are view-only`, kind: "error" };
          this.invalidate();
          return;
        }
        this.confirmName = def.name;
        this.view = "confirm";
        this.invalidate();
      }
    }
  }

  private handleFormInput(data: string): void {
    const form = this.form;
    if (!form) return;
    if (matchesKey(data, Key.escape)) {
      this.form = undefined;
      this.view = "list";
      this.invalidate();
      return;
    }
    const last = FORM_FIELDS.length; // the scope row sits at index == fields.length
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
      form.active = Math.min(last, form.active + 1);
      this.invalidate();
      return;
    }
    if (data === "\x1b[Z" || matchesKey(data, Key.up)) {
      form.active = Math.max(0, form.active - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.submitForm();
      this.invalidate();
      return;
    }
    const key = FORM_FIELDS[form.active];
    // Multi-char printable run (a paste, or a pty burst delivering a typed
    // string in one chunk): append wholesale — a length===1-only gate would
    // silently drop it.
    if (key && data.length > 1 && [...data].every((ch) => ch.charCodeAt(0) >= 32)) {
      form.values[key] += data;
      this.invalidate();
      return;
    }
    if (form.active === last) {
      // Scope row: space/enter toggle (create only), nothing is editable.
      if (data === " " && !form.scopeLocked) {
        form.scope = form.scope === "project" ? "user" : "project";
      }
      this.invalidate();
      return;
    }
    if (key && matchesKey(data, Key.backspace)) {
      form.values[key] = form.values[key].slice(0, -1);
      this.invalidate();
      return;
    }
    if (key && matchesKey(data, Key.ctrl("u"))) {
      form.values[key] = "";
      this.invalidate();
      return;
    }
    if (key && data.length === 1 && data.charCodeAt(0) >= 32) {
      form.values[key] += data;
      this.invalidate();
    }
  }

  private handleConfirmInput(data: string): void {
    if (data === "y" || data === "Y") {
      this.deleteSelected();
      return;
    }
    if (data === "n" || data === "N" || matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.confirmName = undefined;
      this.view = "list";
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedLines =
      this.view === "detail"
        ? this.renderDetail(width)
        : this.view === "form"
          ? this.renderForm(width)
          : this.view === "confirm"
            ? this.renderConfirm(width)
            : this.renderList(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private statusLine(width: number): string | null {
    if (!this.status) return null;
    const color = this.status.kind === "error" ? "error" : "success";
    return truncateToWidth(`  ${this.theme.fg(color, this.status.text)}`, width);
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
    const status = this.statusLine(width);
    if (status) lines.push(status);
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", "↑↓/j k select • enter detail • c create • e edit • d delete • esc close")}`,
        width,
      ),
    );
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
    const editable = def !== undefined && isEditableSource(def.source);
    const footer = editable ? "e edit • d delete • esc back to list" : "esc back to list";
    lines.push(truncateToWidth(`  ${th.fg("dim", footer)}`, width));
    lines.push("");
    return lines;
  }

  private renderForm(width: number): string[] {
    const th = this.theme;
    const form = this.form;
    const lines: string[] = [""];
    if (!form) return lines;
    const title = form.mode === "create" ? " New agentType " : ` Edit ${form.originalName ?? ""} `;
    lines.push(
      truncateToWidth(
        `${th.fg("accent", th.bold(title))}${th.fg("borderMuted", "─".repeat(Math.max(0, width - title.length - 1)))}`,
        width,
      ),
    );
    lines.push("");
    for (let i = 0; i < FORM_FIELDS.length; i++) {
      const key = FORM_FIELDS[i];
      const value = key ? form.values[key] : "";
      const active = i === form.active;
      const cursor = active ? th.bg("selectedBg", "▌") : "";
      const label = th.fg(active ? "accent" : "dim", `${key}:`);
      lines.push(truncateToWidth(`  ${label} [${cursor}${value}]`, width));
    }
    const scopeActive = form.active === FORM_FIELDS.length;
    const scopeHint = form.scopeLocked ? "locked to the definition's source" : "space toggles";
    lines.push(
      truncateToWidth(
        `  ${th.fg(scopeActive ? "accent" : "dim", "scope:")} [${form.scope}]  ${th.fg("dim", scopeHint)}`,
        width,
      ),
    );
    if (form.error) {
      lines.push("");
      lines.push(truncateToWidth(`  ${th.fg("error", form.error)}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "tab/↑↓ field • enter save • esc cancel")}`, width));
    lines.push("");
    return lines;
  }

  private renderConfirm(width: number): string[] {
    const th = this.theme;
    const def = this.confirmName ? this.registry.get(this.confirmName) : undefined;
    const lines: string[] = [""];
    lines.push(
      truncateToWidth(
        `${th.fg("error", th.bold(" Delete definition "))}${th.fg("borderMuted", "─".repeat(Math.max(0, width - 20)))}`,
        width,
      ),
    );
    lines.push("");
    if (!def) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "definition not found")}`, width));
    } else {
      lines.push(truncateToWidth(`  ${th.fg("accent", def.name)} ${th.fg("dim", def.source)}`, width));
      lines.push(
        truncateToWidth(
          `  removes ${this.dirFor(isEditableSource(def.source) ? def.source : "project")}/${def.name}.md`,
          width,
        ),
      );
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "y confirm delete • n/esc cancel")}`, width));
    lines.push("");
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
