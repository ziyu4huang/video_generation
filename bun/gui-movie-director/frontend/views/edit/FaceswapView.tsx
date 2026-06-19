import React from "react";
import { FACESWAP_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

// Persistent view header so the Face Swap panel is never a title-less black
// void: the h2 is always rendered, and the base view already guards against an
// empty schema (sections with no fields) via its empty-state fallback.
const BaseFaceswapView = createCommandView(FACESWAP_SCHEMA);

export function FaceswapView() {
  return (
    <>
      <h2 className="view-header">Face Swap</h2>
      <BaseFaceswapView />
    </>
  );
}

export const faceswapDescriptor: ViewDescriptor = {
  id: "faceswap", group: "Edit", label: "Face Swap", icon: "👤",
  component: FaceswapView,
};
