// Static map: React component name → source file path

const COMPONENT_TO_FILE: Record<string, string> = {
  // Root
  App: "frontend/app.tsx",
  // Layout
  Layout: "frontend/components/Layout.tsx",
  // Components
  Gallery: "frontend/components/Gallery.tsx",
  CommandForm: "frontend/components/CommandForm.tsx",
  LogViewer: "frontend/components/LogViewer.tsx",
  ImagePreview: "frontend/components/ImagePreview.tsx",
  FileUpload: "frontend/components/FileUpload.tsx",
  // Field components
  TextField: "frontend/components/FieldComponents.tsx",
  NumberField: "frontend/components/FieldComponents.tsx",
  RangeField: "frontend/components/FieldComponents.tsx",
  SelectField: "frontend/components/FieldComponents.tsx",
  ToggleField: "frontend/components/FieldComponents.tsx",
  // Forms
  T2iForm: "frontend/forms/t2i.tsx",
  I2iForm: "frontend/forms/i2i.tsx",
  Anime2realForm: "frontend/forms/anime2real.tsx",
  ExpansionForm: "frontend/forms/expansion.tsx",
  FaceswapForm: "frontend/forms/faceswap.tsx",
  SwapForm: "frontend/forms/swap.tsx",
  ControlnetForm: "frontend/forms/controlnet.tsx",
  AngleForm: "frontend/forms/angle.tsx",
  ProfileForm: "frontend/forms/profile.tsx",
  QualityForm: "frontend/forms/quality.tsx",
  WorkflowForm: "frontend/forms/workflow.tsx",
  // Inspector (self-referential)
  DomInspector: "frontend/components/DomInspector.tsx",
  InspectorModal: "frontend/components/DomInspector.tsx",
  MetaRow: "frontend/components/ImagePreview.tsx",
};

export function getSourcePath(componentName: string | null): string | null {
  if (!componentName) return null;
  return COMPONENT_TO_FILE[componentName] ?? null;
}
