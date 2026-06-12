// Barrel re-export — each command schema lives in its own file for isolation.
// Consumers import from "../../schemas" unchanged.

export { PIPELINE_OPTIONS } from "./shared";

// Generate
export { T2I_SCHEMA } from "./t2i";

// Workflow
export { WORKFLOW_SCHEMA } from "./workflow";

// Transform
export { I2I_SCHEMA } from "./i2i";
export { IMAGE_RESTORE_SCHEMA } from "./image-restore";
export { ANIME2REAL_SCHEMA } from "./anime2real";
export { EXPANSION_SCHEMA } from "./expansion";

// Edit
export { FACESWAP_SCHEMA } from "./faceswap";
export { SWAP_SCHEMA } from "./swap";
export { CONTROLNET_SCHEMA } from "./controlnet";
export { ANGLE_SCHEMA } from "./angle";

// Analyze
export { PROFILE_SCHEMA } from "./profile";
export { QUALITY_SCHEMA } from "./quality";
