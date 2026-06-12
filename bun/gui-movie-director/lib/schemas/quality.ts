import type { CommandSchema } from "./shared";

export const quality: CommandSchema = {
  quality_inputs: { type: "string", cliFlag: "--quality-inputs", required: true },
};
