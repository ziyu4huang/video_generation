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
  // Views (schema-driven)
  T2iView: "frontend/views/generate/T2iView.tsx",
  WorkflowView: "frontend/views/generate/WorkflowView.tsx",
  I2iView: "frontend/views/transform/I2iView.tsx",
  Anime2realView: "frontend/views/transform/Anime2realView.tsx",
  ExpansionView: "frontend/views/transform/ExpansionView.tsx",
  FaceswapView: "frontend/views/edit/FaceswapView.tsx",
  SwapView: "frontend/views/edit/SwapView.tsx",
  ControlnetView: "frontend/views/edit/ControlnetView.tsx",
  AngleView: "frontend/views/edit/AngleView.tsx",
  ProfileView: "frontend/views/analyze/ProfileView.tsx",
  QualityView: "frontend/views/analyze/QualityView.tsx",
  // Inspector (self-referential)
  DomInspector: "frontend/components/DomInspector.tsx",
  InspectorModal: "frontend/components/DomInspector.tsx",
  MetaRow: "frontend/components/ImagePreview.tsx",
};

export function getSourcePath(componentName: string | null): string | null {
  if (!componentName) return null;
  return COMPONENT_TO_FILE[componentName] ?? null;
}
