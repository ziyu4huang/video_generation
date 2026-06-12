import { COMMAND_SCHEMAS, type CommandSchema, type FieldSchema } from "./schemas";

/**
 * Build CLI arguments from a form submission for a given action.
 *
 * Rules:
 * - String/Number: `--flag value`
 * - Boolean true: `--flag` (no value)
 * - Boolean false / null / undefined: omit
 * - Empty string: omit
 */
export function buildCliArgs(action: string, params: Record<string, any>): string[] {
  const schema = COMMAND_SCHEMAS[action];
  if (!schema) {
    throw new Error(`Unknown action: ${action}`);
  }

  const args: string[] = [];

  for (const [key, field] of Object.entries(schema)) {
    const value = params[key];

    if (value === undefined || value === null) continue;

    if (field.type === "boolean") {
      if (value === true) {
        args.push(field.cliFlag);
      }
      // false → omit
    } else if (field.type === "string") {
      if (typeof value === "string" && value.trim() !== "") {
        args.push(field.cliFlag, value.trim());
      }
    } else if (field.type === "number") {
      if (typeof value === "number" && !isNaN(value)) {
        args.push(field.cliFlag, String(value));
      }
    } else if (field.type === "select") {
      if (typeof value === "string" && value.trim() !== "") {
        args.push(field.cliFlag, value.trim());
      }
    } else if (field.type === "multiselect") {
      // Array of strings → repeated --flag value1 --flag value2
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim() !== "") {
            args.push(field.cliFlag, item.trim());
          }
        }
      }
    }
  }

  return args;
}

/**
 * Validate required parameters for a given action.
 * Returns an array of error messages (empty if valid).
 */
export function validateParams(action: string, params: Record<string, any>): string[] {
  const schema = COMMAND_SCHEMAS[action];
  if (!schema) return [`Unknown action: ${action}`];

  const errors: string[] = [];

  for (const [key, field] of Object.entries(schema)) {
    if (field.required) {
      const value = params[key];
      if (value === undefined || value === null || value === "") {
        errors.push(`Missing required parameter: ${key} (${field.cliFlag})`);
      }
    }
  }

  return errors;
}
