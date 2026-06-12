// Shared types and reusable field definitions for backend CLI arg schemas.

export type FieldType = "string" | "number" | "boolean" | "select" | "multiselect";

export interface FieldSchema {
  type: FieldType;
  cliFlag: string;       // e.g. "--prompt", "--lora-scale"
  required?: boolean;
  default?: any;
  choices?: string[];    // For select fields
  min?: number;
  max?: number;
}

export type CommandSchema = Record<string, FieldSchema>;

// Shared/common fields used by multiple commands
export const PROMPT: FieldSchema = { type: "string", cliFlag: "--prompt", required: false };
export const STEPS: FieldSchema = { type: "number", cliFlag: "--steps" };
export const SEED: FieldSchema = { type: "number", cliFlag: "--seed", default: 42 };
export const LORA_PATH: FieldSchema = { type: "string", cliFlag: "--lora-path" };
export const LORA_SCALE: FieldSchema = { type: "number", cliFlag: "--lora-scale", default: 1.0, min: 0, max: 2 };
export const VAE_PATH: FieldSchema = { type: "string", cliFlag: "--vae-path" };
export const INPUT_IMAGE: FieldSchema = { type: "string", cliFlag: "--input" };
export const DENOISE: FieldSchema = { type: "number", cliFlag: "--denoise-strength", default: 1.0, min: 0, max: 1 };
export const PIPELINE: FieldSchema = { type: "select", cliFlag: "--pipeline", choices: ["zimage", "flux2-klein"], default: "zimage" };
