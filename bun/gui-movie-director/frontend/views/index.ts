export type { ViewDescriptor } from "./registry";
export { GROUP_ORDER } from "./registry";

import { t2iDescriptor } from "./generate/T2iView";
import { imagePipelineDescriptor } from "./workflow/ImagePipelineView";
import { videoGenerateDescriptor } from "./workflow/VideoGenerateView";
import { videoRelayDescriptor } from "./workflow/VideoRelayView";
import { videoRestoreDescriptor } from "./workflow/VideoRestoreView";
import { i2iDescriptor } from "./transform/I2iView";
import { imageRestoreDescriptor } from "./transform/ImageRestoreView";
import { anime2realDescriptor } from "./transform/Anime2realView";
import { expansionDescriptor } from "./transform/ExpansionView";
import { faceswapDescriptor } from "./edit/FaceswapView";
import { swapDescriptor } from "./edit/SwapView";
import { controlnetDescriptor } from "./edit/ControlnetView";
import { angleDescriptor } from "./edit/AngleView";
import { profileDescriptor } from "./analyze/ProfileView";
import { qualityDescriptor } from "./analyze/QualityView";
import { modelCheckDescriptor } from "./tools/ModelCheckView";
import type { ViewDescriptor } from "./registry";

export const VIEWS: ViewDescriptor[] = [
  t2iDescriptor,
  imagePipelineDescriptor,
  videoGenerateDescriptor,
  videoRelayDescriptor,
  videoRestoreDescriptor,
  i2iDescriptor,
  imageRestoreDescriptor,
  anime2realDescriptor,
  expansionDescriptor,
  faceswapDescriptor,
  swapDescriptor,
  controlnetDescriptor,
  angleDescriptor,
  profileDescriptor,
  qualityDescriptor,
  modelCheckDescriptor,
];
