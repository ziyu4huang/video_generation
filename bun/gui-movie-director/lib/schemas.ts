// Unified source of truth: each command is defined once in schemas/<cmd>.ts.
// toCliFields() adapts to the Record<key, FieldSchema> shape that lib/args.ts needs.

import { toCliFields } from "../schemas/toCli";
import { t2iCommand } from "../schemas/t2i";
import { i2iCommand } from "../schemas/i2i";
import { anime2realCommand } from "../schemas/anime2real";
import { expansionCommand } from "../schemas/expansion";
import { faceswapCommand } from "../schemas/faceswap";
import { swapCommand } from "../schemas/swap";
import { controlnetCommand } from "../schemas/controlnet";
import { angleCommand } from "../schemas/angle";
import { profileCommand } from "../schemas/profile";
import { qualityCommand } from "../schemas/quality";
import { workflowCommand } from "../schemas/workflow";
import { videoGenerateCommand } from "../schemas/video-generate";
import { videoRelayCommand } from "../schemas/video-relay";
import { videoRestoreCommand } from "../schemas/video-restore";
import { imageRestoreCommand } from "../schemas/image-restore";

export type { FieldType, FieldSchema, CommandSchema } from "./schemas/shared";

export const COMMAND_SCHEMAS: Record<string, Record<string, any>> = {
  t2i: toCliFields(t2iCommand),
  i2i: toCliFields(i2iCommand),
  anime2real: toCliFields(anime2realCommand),
  expansion: toCliFields(expansionCommand),
  faceswap: toCliFields(faceswapCommand),
  swap: toCliFields(swapCommand),
  controlnet: toCliFields(controlnetCommand),
  angle: toCliFields(angleCommand),
  profile: toCliFields(profileCommand),
  quality: toCliFields(qualityCommand),
  workflow: toCliFields(workflowCommand),
  "video-generate": toCliFields(videoGenerateCommand),
  "video-relay": toCliFields(videoRelayCommand),
  "video-restore": toCliFields(videoRestoreCommand),
  restore: toCliFields(imageRestoreCommand),
};
