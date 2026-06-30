import React from "react";
import { T2I_SCHEMA } from "../../schemas";
import { createCommandView } from "../CommandView";
import type { ViewDescriptor } from "../registry";

const BaseT2iView = createCommandView(T2I_SCHEMA);

export const T2iView = () => (
  <div style={{ maxWidth: 1200 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 20 }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-bright)", margin: 0 }}>
        🎨 Text → Image
      </h2>
      <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
        Compose a prompt and generate an image
      </span>
    </div>
    <BaseT2iView />
  </div>
);

export const t2iDescriptor: ViewDescriptor = {
  id: "t2i", group: "Generate", label: "Text → Image", icon: "🎨",
  component: T2iView,
};
