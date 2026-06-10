import React from "react";
import { ALL_COMMANDS } from "../app";
import { T2iForm } from "../forms/t2i";
import { I2iForm } from "../forms/i2i";
import { Anime2realForm } from "../forms/anime2real";
import { ExpansionForm } from "../forms/expansion";
import { FaceswapForm } from "../forms/faceswap";
import { SwapForm } from "../forms/swap";
import { ControlnetForm } from "../forms/controlnet";
import { AngleForm } from "../forms/angle";
import { ProfileForm } from "../forms/profile";
import { QualityForm } from "../forms/quality";
import { WorkflowForm } from "../forms/workflow";

interface CommandFormProps {
  action: string;
  onJobStart: (job: any) => void;
  loading: boolean;
}

const FORM_MAP: Record<string, React.ComponentType<any>> = {
  t2i: T2iForm,
  i2i: I2iForm,
  anime2real: Anime2realForm,
  expansion: ExpansionForm,
  faceswap: FaceswapForm,
  swap: SwapForm,
  controlnet: ControlnetForm,
  angle: AngleForm,
  profile: ProfileForm,
  quality: QualityForm,
  workflow: WorkflowForm,
};

export function CommandForm({ action, onJobStart, loading }: CommandFormProps) {
  const cmd = ALL_COMMANDS.find((c) => c.id === action);
  const FormComponent = FORM_MAP[action];

  if (!FormComponent) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🚧</div>
        <div className="empty-state-text">
          Form for "{action}" is not implemented yet.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>{cmd?.icon} {cmd?.label || action}</h2>
      <FormComponent onJobStart={onJobStart} loading={loading} />
    </div>
  );
}
