export type { ViewDescriptor } from "./registry";
export { GROUP_ORDER } from "./registry";

import { t2iDescriptor } from "./generate/T2iView";
import { imagePipelineDescriptor } from "./workflow/ImagePipelineView";
import { videoGenerateDescriptor } from "./workflow/VideoGenerateView";
import { videoT2i2vDescriptor } from "./workflow/VideoT2i2vView";
import { videoRelayDescriptor } from "./workflow/VideoRelayView";
import { videoRestoreDescriptor } from "./workflow/VideoRestoreView";
import { videoCompareDescriptor } from "./workflow/VideoCompareView";
import { videoQualityDescriptor } from "./workflow/VideoQualityView";
import { videoVbvrDescriptor } from "./workflow/VideoVbvrView";
import { i2iDescriptor } from "./transform/I2iView";
import { imageRestoreDescriptor } from "./transform/ImageRestoreView";
import { purifyDescriptor } from "./transform/PurifyView";
import { anime2realDescriptor } from "./transform/Anime2realView";
import { expansionDescriptor } from "./transform/ExpansionView";
import { faceswapDescriptor } from "./edit/FaceswapView";
import { swapDescriptor } from "./edit/SwapView";
import { controlnetDescriptor } from "./edit/ControlnetView";
import { angleDescriptor } from "./edit/AngleView";
import { profileDescriptor } from "./analyze/ProfileView";
import { qualityDescriptor } from "./analyze/QualityView";
import { modelCheckDescriptor } from "./tools/ModelCheckView";
import { knowledgeDescriptor } from "./tools/KnowledgeView";
import type { ViewDescriptor } from "./registry";

export const VIEWS: ViewDescriptor[] = [
  t2iDescriptor,
  imagePipelineDescriptor,
  videoGenerateDescriptor,
  videoT2i2vDescriptor,
  videoRelayDescriptor,
  videoRestoreDescriptor,
  videoCompareDescriptor,
  videoQualityDescriptor,
  videoVbvrDescriptor,
  i2iDescriptor,
  imageRestoreDescriptor,
  purifyDescriptor,
  anime2realDescriptor,
  expansionDescriptor,
  faceswapDescriptor,
  swapDescriptor,
  controlnetDescriptor,
  angleDescriptor,
  profileDescriptor,
  qualityDescriptor,
  modelCheckDescriptor,
  knowledgeDescriptor,
];
