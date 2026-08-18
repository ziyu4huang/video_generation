import { describe, it, expect } from "bun:test";
import { toSections } from "./toForm";
import { ALL_COMMANDS } from "./registry";
import type { UnifiedField } from "./types";

/**
 * `fieldToUi` is a copy-WHITELIST: it names each UnifiedField property it
 * forwards to the UI shape. Anything not named is dropped silently, and the
 * consumer sees `undefined` — indistinguishable from "the author set nothing".
 *
 * `hint` was dropped that way for its whole life. CommandForm called
 * `field.hint?.(...)`, purify.ts authored a hint warning that seedvr2 at
 * 2x/2160 can hard-crash the GPU (exit 134), and the value never crossed the
 * boundary, so the warning never rendered. Measured before the fix:
 * `toSections(purifyCommand)` carried zero of its one authored hint.
 *
 * These assert on EVERY registered command rather than on a fixture, so a new
 * schema authoring a hint is covered without touching this file.
 */
describe("toSections carries authored field properties to the UI shape", () => {
  const authored = (cmd: (typeof ALL_COMMANDS)[number], pick: (f: UnifiedField) => boolean) =>
    cmd.fields.filter((f) => f.section && pick(f)).map((f) => f.key).sort();

  const rendered = (cmd: (typeof ALL_COMMANDS)[number], pick: (f: Record<string, any>) => boolean) => {
    const keys: string[] = [];
    for (const s of toSections(cmd).sections) for (const f of s.fields as Record<string, any>[]) if (pick(f)) keys.push(f.key);
    return keys.sort();
  };

  it("every authored hint survives toSections", () => {
    // Guard the guard: if no command authors a hint the assertion below is
    // vacuous, and this file would pass while proving nothing.
    const total = ALL_COMMANDS.reduce((n, cmd) => n + authored(cmd, (f) => f.hint !== undefined).length, 0);
    expect(total).toBeGreaterThan(0);

    for (const cmd of ALL_COMMANDS) {
      expect(rendered(cmd, (f) => f.hint !== undefined)).toEqual(authored(cmd, (f) => f.hint !== undefined));
    }
  });

  it("a function hint stays callable across the boundary (not stringified)", () => {
    for (const cmd of ALL_COMMANDS) {
      for (const s of toSections(cmd).sections) {
        for (const f of s.fields as Record<string, any>[]) {
          if (f.hint === undefined) continue;
          expect(["string", "function"]).toContain(typeof f.hint);
        }
      }
    }
  });

  it("no field carries a `help` property — hint is the only spelling", () => {
    // Two schemas used `help:`, which nothing read. Keeping both spellings
    // alive is how the dead one comes back.
    for (const cmd of ALL_COMMANDS) {
      for (const f of cmd.fields as Record<string, any>[]) {
        expect(f.help).toBeUndefined();
      }
    }
  });
});
