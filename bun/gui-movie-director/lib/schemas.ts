// Unified source of truth: each command is defined once in schemas/<cmd>.ts.
// toCliFields() adapts to the Record<key, FieldSchema> shape that lib/args.ts needs.
// ALL_COMMANDS comes from schemas/registry.ts — add new commands there.

import { toCliFields } from "../schemas/toCli";
import { ALL_COMMANDS } from "../schemas/registry";

export type { FieldType, FieldSchema, CommandSchema } from "./schemas/shared";

export const COMMAND_SCHEMAS: Record<string, Record<string, any>> = Object.fromEntries(
  ALL_COMMANDS.map((cmd) => [cmd.action, toCliFields(cmd)])
);
