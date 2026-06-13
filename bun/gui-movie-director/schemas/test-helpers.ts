import { describe, it, expect } from "bun:test";
import { toCliFields } from "./toCli";
import { toSections } from "./toForm";
import type { UnifiedCommand } from "./types";

const VALID_CONTROLS = ["prompt", "text", "number", "range", "select", "toggle", "image", "images"];

// Runs the standard invariant suite for any UnifiedCommand.
// Call this at module top level from each command test file.
export function invariants(cmd: UnifiedCommand) {
  const name = cmd.action;

  describe(`${name}: schema invariants`, () => {
    it("action is a non-empty string", () => {
      expect(typeof cmd.action).toBe("string");
      expect(cmd.action.length).toBeGreaterThan(0);
    });

    it("has submitLabel and runningLabel strings", () => {
      expect(typeof cmd.submitLabel).toBe("string");
      expect(cmd.submitLabel.length).toBeGreaterThan(0);
      expect(typeof cmd.runningLabel).toBe("string");
      expect(cmd.runningLabel.length).toBeGreaterThan(0);
    });

    it("has at least one field", () => {
      expect(cmd.fields.length).toBeGreaterThan(0);
    });

    it("field keys are unique", () => {
      const keys = cmd.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("all control types are valid", () => {
      for (const f of cmd.fields) {
        expect(VALID_CONTROLS).toContain(f.control);
      }
    });

    it("all cliFlags start with --", () => {
      for (const f of cmd.fields) {
        if (f.cliFlag !== undefined) {
          expect(f.cliFlag).toMatch(/^--/);
        }
      }
    });

    it("select fields have non-empty choices", () => {
      for (const f of cmd.fields) {
        if (f.control === "select") {
          expect(f.choices).toBeDefined();
          expect(f.choices!.length).toBeGreaterThan(0);
          for (const c of f.choices!) {
            expect(typeof c.value).toBe("string");
            expect(typeof c.label).toBe("string");
          }
        }
      }
    });

    it("range fields with min and max have min < max", () => {
      for (const f of cmd.fields) {
        if (f.control === "range" && f.min != null && f.max != null) {
          expect(f.max).toBeGreaterThan(f.min);
        }
      }
    });

    it("number fields with min and max have valid range", () => {
      for (const f of cmd.fields) {
        if (f.control === "number" && f.min != null && f.max != null) {
          expect(f.max).toBeGreaterThan(f.min);
        }
      }
    });

    it("numeric defaults are within min/max bounds", () => {
      for (const f of cmd.fields) {
        if (typeof f.default === "number" && f.min != null && f.max != null) {
          expect(f.default).toBeGreaterThanOrEqual(f.min);
          expect(f.default).toBeLessThanOrEqual(f.max);
        }
      }
    });
  });

  describe(`${name}: toCliFields adapter`, () => {
    const cliFields = toCliFields(cmd);

    it("returns a non-empty map when any cliFlag fields exist", () => {
      const hasCliFields = cmd.fields.some((f) => f.cliFlag);
      if (hasCliFields) {
        expect(Object.keys(cliFields).length).toBeGreaterThan(0);
      }
    });

    it("excludes fields without cliFlag", () => {
      for (const f of cmd.fields) {
        if (!f.cliFlag) {
          expect(cliFields[f.key]).toBeUndefined();
        }
      }
    });

    it("maps select control to 'select' CliType", () => {
      for (const f of cmd.fields) {
        if (f.cliFlag && f.control === "select") {
          expect(cliFields[f.key].type).toBe("select");
        }
      }
    });

    it("maps toggle control to 'boolean' CliType", () => {
      for (const f of cmd.fields) {
        if (f.cliFlag && f.control === "toggle") {
          expect(cliFields[f.key].type).toBe("boolean");
        }
      }
    });

    it("maps images control to 'multiselect' CliType", () => {
      for (const f of cmd.fields) {
        if (f.cliFlag && f.control === "images") {
          expect(cliFields[f.key].type).toBe("multiselect");
        }
      }
    });

    it("select fields in CLI map have string[] choices", () => {
      for (const [, field] of Object.entries(cliFields)) {
        if (field.type === "select") {
          expect(Array.isArray(field.choices)).toBe(true);
          for (const c of field.choices!) {
            expect(typeof c).toBe("string");
          }
        }
      }
    });

    it("required fields propagate to CLI map", () => {
      for (const f of cmd.fields) {
        if (f.cliFlag && f.required) {
          expect(cliFields[f.key].required).toBe(true);
        }
      }
    });
  });

  describe(`${name}: toSections adapter`, () => {
    const schema = toSections(cmd);

    it("preserves action, submitLabel, runningLabel", () => {
      expect(schema.action).toBe(cmd.action);
      expect(schema.submitLabel).toBe(cmd.submitLabel);
      expect(schema.runningLabel).toBe(cmd.runningLabel);
    });

    it("produces at least one section when section fields exist", () => {
      const hasSectionFields = cmd.fields.some((f) => f.section);
      if (hasSectionFields) {
        expect(schema.sections.length).toBeGreaterThan(0);
      }
    });

    it("excludes fields without section from UI", () => {
      const uiKeys = new Set(schema.sections.flatMap((s: any) => s.fields.map((f: any) => f.key)));
      for (const f of cmd.fields) {
        if (!f.section) {
          expect(uiKeys.has(f.key)).toBe(false);
        }
      }
    });

    it("isDisabled is a function", () => {
      expect(typeof schema.isDisabled).toBe("function");
    });
  });
}
