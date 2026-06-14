// Central command registry. All UnifiedCommand definitions are imported here.
// To add a new command: create schemas/<cmd>.ts then add it to ALL_COMMANDS below.
// lib/schemas.ts and frontend/schemas/index.ts both derive their registries from this array.

import type { UnifiedCommand } from "./types";
import { t2iCommand } from "./t2i";
import { i2iCommand } from "./i2i";
import { anime2realCommand } from "./anime2real";
import { expansionCommand } from "./expansion";
import { faceswapCommand } from "./faceswap";
import { swapCommand } from "./swap";
import { controlnetCommand } from "./controlnet";
import { angleCommand } from "./angle";
import { profileCommand } from "./profile";
import { qualityCommand } from "./quality";
import { workflowCommand } from "./workflow";
import { videoGenerateCommand } from "./video-generate";
import { videoRelayCommand } from "./video-relay";
import { videoRestoreCommand } from "./video-restore";
import { imageRestoreCommand } from "./image-restore";
import { videoCompareCommand } from "./video-compare";
import { videoQualityCommand } from "./video-quality";
import { videoVbvrCommand } from "./video-vbvr";

export const ALL_COMMANDS: UnifiedCommand[] = [
  // Generate
  t2iCommand,
  // Workflow
  workflowCommand,
  videoGenerateCommand,
  videoRelayCommand,
  videoRestoreCommand,
  videoCompareCommand,
  videoQualityCommand,
  videoVbvrCommand,
  // Transform
  i2iCommand,
  imageRestoreCommand,
  anime2realCommand,
  expansionCommand,
  // Edit
  faceswapCommand,
  swapCommand,
  controlnetCommand,
  angleCommand,
  // Analyze
  profileCommand,
  qualityCommand,
];
