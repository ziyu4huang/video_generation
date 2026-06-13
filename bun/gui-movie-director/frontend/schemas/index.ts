// Unified source of truth: each command is defined once in schemas/<cmd>.ts.
// toSections() adapts to the CommandSchema shape that CommandForm/CommandView expect.
// ALL_COMMANDS comes from schemas/registry.ts — add new commands there.
// Consumers import named schemas unchanged (e.g. import { T2I_SCHEMA } from "../../schemas").

import { toSections } from "../../schemas/toForm";
import { ALL_COMMANDS } from "../../schemas/registry";
import type { CommandSchema } from "./types";

export { PIPELINE_OPTIONS } from "../../schemas/shared";

const SCHEMA_MAP: Record<string, CommandSchema> = Object.fromEntries(
  ALL_COMMANDS.map((cmd) => [cmd.action, toSections(cmd) as CommandSchema])
);

// Generate
export const T2I_SCHEMA = SCHEMA_MAP["t2i"];

// Workflow
export const WORKFLOW_SCHEMA = SCHEMA_MAP["workflow"];
export const VIDEO_GENERATE_SCHEMA = SCHEMA_MAP["video-generate"];
export const VIDEO_RELAY_SCHEMA = SCHEMA_MAP["video-relay"];
export const VIDEO_RESTORE_SCHEMA = SCHEMA_MAP["video-restore"];

// Transform
export const I2I_SCHEMA = SCHEMA_MAP["i2i"];
export const IMAGE_RESTORE_SCHEMA = SCHEMA_MAP["restore"];
export const ANIME2REAL_SCHEMA = SCHEMA_MAP["anime2real"];
export const EXPANSION_SCHEMA = SCHEMA_MAP["expansion"];

// Edit
export const FACESWAP_SCHEMA = SCHEMA_MAP["faceswap"];
export const SWAP_SCHEMA = SCHEMA_MAP["swap"];
export const CONTROLNET_SCHEMA = SCHEMA_MAP["controlnet"];
export const ANGLE_SCHEMA = SCHEMA_MAP["angle"];

// Analyze
export const PROFILE_SCHEMA = SCHEMA_MAP["profile"];
export const QUALITY_SCHEMA = SCHEMA_MAP["quality"];
