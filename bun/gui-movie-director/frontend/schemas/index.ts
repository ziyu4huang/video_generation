// Unified source of truth: each command is defined once in schemas/<cmd>.ts.
// toSections() adapts to the CommandSchema shape that CommandForm/CommandView expect.
// Consumers import named schemas unchanged (e.g. import { T2I_SCHEMA } from "../../schemas").

import { toSections } from "../../schemas/toForm";
import { t2iCommand } from "../../schemas/t2i";
import { i2iCommand } from "../../schemas/i2i";
import { anime2realCommand } from "../../schemas/anime2real";
import { expansionCommand } from "../../schemas/expansion";
import { faceswapCommand } from "../../schemas/faceswap";
import { swapCommand } from "../../schemas/swap";
import { controlnetCommand } from "../../schemas/controlnet";
import { angleCommand } from "../../schemas/angle";
import { profileCommand } from "../../schemas/profile";
import { qualityCommand } from "../../schemas/quality";
import { workflowCommand } from "../../schemas/workflow";
import { imageRestoreCommand } from "../../schemas/image-restore";
import type { CommandSchema } from "./types";

export { PIPELINE_OPTIONS } from "../../schemas/shared";

// Generate
export const T2I_SCHEMA = toSections(t2iCommand) as CommandSchema;

// Workflow
export const WORKFLOW_SCHEMA = toSections(workflowCommand) as CommandSchema;

// Transform
export const I2I_SCHEMA = toSections(i2iCommand) as CommandSchema;
export const IMAGE_RESTORE_SCHEMA = toSections(imageRestoreCommand) as CommandSchema;
export const ANIME2REAL_SCHEMA = toSections(anime2realCommand) as CommandSchema;
export const EXPANSION_SCHEMA = toSections(expansionCommand) as CommandSchema;

// Edit
export const FACESWAP_SCHEMA = toSections(faceswapCommand) as CommandSchema;
export const SWAP_SCHEMA = toSections(swapCommand) as CommandSchema;
export const CONTROLNET_SCHEMA = toSections(controlnetCommand) as CommandSchema;
export const ANGLE_SCHEMA = toSections(angleCommand) as CommandSchema;

// Analyze
export const PROFILE_SCHEMA = toSections(profileCommand) as CommandSchema;
export const QUALITY_SCHEMA = toSections(qualityCommand) as CommandSchema;
