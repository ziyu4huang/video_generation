/**
 * /extensions slash command for pi-agent-ext-power-tool.
 *
 * Browse loaded pi-agent-extensions and see what each provides
 * (tools/commands/skills). Registered by power-tool, which already owns
 * `inspect_extensions` + the `getAllTools()` closure.
 *
 * The pure helpers (extName, groupByExtension, renderSummary, renderDetail) are
 * unit-tested directly; `makeExtensionsCommand` is thin glue over them.
 *
 * Attribution reuses the `pi-agent-ext-<name>` derivation: each item's
 * `sourceInfo` (path / source / baseDir) is scanned for the segment.
 */
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

const EXT_RE = /pi-agent-ext-([a-z0-9-]+)/i;
export const OTHER = "(core & other)";

export type Sourced = { name: string; sourceInfo?: { path?: string; source?: string; baseDir?: string } };

/** Derive the pi-agent-ext-<name> segment from a sourceInfo, else undefined. */
export function extName(si: Sourced["sourceInfo"]): string | undefined {
  if (!si) return undefined;
  const hay = `${si.path ?? ""} ${si.source ?? ""} ${si.baseDir ?? ""}`;
  const m = hay.match(EXT_RE);
  return m ? m[1] : undefined;
}

export interface ExtGroup {
  tools: string[];
  commands: string[];
  skills: string[];
}

/** Bucket tools/commands/skills by owning extension (pi-agent-ext-<name>),
 *  non-extension items under OTHER. Sorted alpha with OTHER last. */
export function groupByExtension(input: {
  tools: Sourced[];
  commands: Sourced[];
  skills: Sourced[];
}): Map<string, ExtGroup> {
  const groups = new Map<string, ExtGroup>();
  const bucket = (name: string, si: Sourced["sourceInfo"], key: keyof ExtGroup) => {
    const ext = extName(si) ?? OTHER;
    let g = groups.get(ext);
    if (!g) {
      g = { tools: [], commands: [], skills: [] };
      groups.set(ext, g);
    }
    g[key].push(name);
  };
  for (const t of input.tools) bucket(t.name, t.sourceInfo, "tools");
  for (const c of input.commands) bucket(c.name, c.sourceInfo, "commands");
  for (const s of input.skills) bucket(s.name, s.sourceInfo, "skills");
  return new Map(
    [...groups.entries()].sort(([a], [b]) => {
      if (a === OTHER) return 1;
      if (b === OTHER) return -1;
      return a.localeCompare(b);
    }),
  );
}

export function renderSummary(groups: Map<string, ExtGroup>): string {
  const lines = ["Loaded extensions:", ""];
  for (const [ext, g] of groups) {
    const tag = ext === OTHER ? ext : `pi-agent-ext-${ext}`;
    lines.push(
      `${tag.padEnd(34)} ${g.tools.length} tool · ${g.commands.length} cmd · ${g.skills.length} skill`,
    );
  }
  lines.push("", "Drill in: /extensions <name>   (or /extensions then pick)");
  return lines.join("\n");
}

export function renderDetail(ext: string, g: ExtGroup): string {
  const tag = ext === OTHER ? ext : `pi-agent-ext-${ext}`;
  const lines = [tag, ""];
  const section = (label: string, items: string[]) => {
    lines.push(`${label}:`);
    if (items.length) for (const n of [...items].sort()) lines.push(`  ${n}`);
    else lines.push("  (none)");
  };
  section("tools", g.tools);
  section("commands", g.commands);
  section("skills", g.skills);
  return lines.join("\n");
}

/** Build the /extensions command. getAllTools/getCommands are closures (deferred);
 *  skills come from ctx at handler time (so the no-arg picker is complete). */
export function makeExtensionsCommand(
  getAllTools: () => Sourced[],
  getCommands: () => Sourced[],
): Pick<RegisteredCommand, "name" | "description" | "handler" | "getArgumentCompletions"> {
  return {
    name: "extensions",
    description:
      "Browse loaded pi-agent extensions and the tools/commands/skills each provides. No args = pick from a list; <name> = drill in.",
    async handler(args, ctx: ExtensionCommandContext) {
      const tools = getAllTools();
      const commands = getCommands();
      const skills =
        (
          (ctx as unknown as { getSystemPromptOptions?: () => { skills?: Sourced[] } })
            .getSystemPromptOptions?.()?.skills ?? []
        ) as Sourced[];
      const groups = groupByExtension({ tools, commands, skills });
      const names = [...groups.keys()].filter((n) => n !== OTHER);
      const strip = (s: string) => s.replace(/^pi-agent-ext-/, "");
      const arg = args.trim();

      // Cast-through-unknown keeps us decoupled from private ui-field shapes.
      const ui = (ctx as unknown as {
        ui: { notify: (m: string, l?: string) => void; select?: (t: string, o: string[]) => Promise<string | undefined> };
      }).ui;

      if (arg) {
        const key = names.includes(arg)
          ? arg
          : names.includes(strip(arg))
            ? strip(arg)
            : names.find((n) => n === arg || `pi-agent-ext-${n}` === arg);
        const g = key ? groups.get(key) : undefined;
        ui.notify(
          g ? renderDetail(key as string, g) : `No extension '${arg}'. Run /extensions to list.`,
          "info",
        );
        return;
      }

      if (ui && typeof ui.select === "function" && names.length) {
        try {
          const choice = await ui.select("Extensions", names.map((n) => `pi-agent-ext-${n}`));
          if (choice) {
            const ext = strip(choice);
            const g = groups.get(ext);
            ui.notify(g ? renderDetail(ext, g) : renderSummary(groups), "info");
            return;
          }
        } catch {
          /* fall through to summary */
        }
      }
      ui.notify(renderSummary(groups), "info");
    },
    getArgumentCompletions(prefix: string) {
      // Best-effort: no ctx here, so only tools+commands (skill-only extensions may be absent).
      const groups = groupByExtension({ tools: getAllTools(), commands: getCommands(), skills: [] });
      const items = [...groups.entries()]
        .filter(([n]) => n !== OTHER)
        .map(([n, g]) => ({
          value: n,
          label: `pi-agent-ext-${n}`,
          description: `${g.tools.length} tool · ${g.commands.length} cmd`,
        }));
      if (!prefix) return items;
      const p = prefix.toLowerCase();
      const filtered = items.filter(
        (it) => it.value.toLowerCase().includes(p) || it.label.toLowerCase().includes(p),
      );
      return filtered.length ? filtered : null;
    },
  };
}
