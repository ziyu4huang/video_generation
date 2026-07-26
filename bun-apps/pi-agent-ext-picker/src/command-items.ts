/**
 * command-items.ts — map slash-commands to menu SelectItems (testable, pi-tui only).
 * Extracted from the picker consumer so the data-shape is unit-tested without
 * pulling the interactive layer.
 */
import type { SelectItem } from "@earendil-works/pi-tui";

/** Minimal shape we consume from SlashCommandInfo (name + optional description). */
export interface CommandLike {
  name: string;
  description?: string;
}

/** SlashCommandInfo[] → SelectItem[]; normalize so every value carries the
 * leading "/" (getCommands() names may or may not already include it). */
export function toCommandItems(commands: CommandLike[]): SelectItem[] {
  return commands.map((c) => {
    const name = c.name.replace(/^\//, "");
    return { value: `/${name}`, label: `/${name}`, description: c.description };
  });
}
