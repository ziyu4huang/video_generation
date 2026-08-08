import { publishSeam } from "../src/seam.js";
// @ts-expect-error — "__piFoo" is not a registered SeamKey (orphan prevention)
publishSeam("__piFoo", {});
