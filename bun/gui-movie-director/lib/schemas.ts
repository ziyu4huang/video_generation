// Barrel re-export — each command schema lives in lib/schemas/<name>.ts for isolation.
// lib/args.ts does COMMAND_SCHEMAS[action] lookup, so we preserve a single merged record.

import { t2i } from "./schemas/t2i";
import { i2i } from "./schemas/i2i";
import { anime2real } from "./schemas/anime2real";
import { expansion } from "./schemas/expansion";
import { faceswap } from "./schemas/faceswap";
import { swap } from "./schemas/swap";
import { controlnet } from "./schemas/controlnet";
import { angle } from "./schemas/angle";
import { profile } from "./schemas/profile";
import { quality } from "./schemas/quality";
import { workflow } from "./schemas/workflow";
import { videoGenerate } from "./schemas/video-generate";
import { videoRestore } from "./schemas/video-restore";
import { imageRestore } from "./schemas/image-restore";

export type { FieldType, FieldSchema, CommandSchema } from "./schemas/shared";

export const COMMAND_SCHEMAS: Record<string, import("./schemas/shared").CommandSchema> = {
  t2i,
  i2i,
  anime2real,
  expansion,
  faceswap,
  swap,
  controlnet,
  angle,
  profile,
  quality,
  workflow,
  "video-generate": videoGenerate,
  "video-restore": videoRestore,
  restore: imageRestore,
};
