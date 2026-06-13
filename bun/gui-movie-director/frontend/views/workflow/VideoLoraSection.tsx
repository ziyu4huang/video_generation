import React from "react";
import { FormSection } from "../../components/FormSection";
import { TextField, RangeField } from "../../components/FieldComponents";

interface Props {
  loraPath: string;
  loraScale: number;
  onPathChange: (v: string) => void;
  onScaleChange: (v: number) => void;
  placeholder?: string;
}

export function VideoLoraSection({ loraPath, loraScale, onPathChange, onScaleChange, placeholder }: Props) {
  return (
    <FormSection title="LoRA">
      <div className="form-row">
        <TextField
          label="LoRA Path"
          value={loraPath}
          onChange={onPathChange}
          placeholder={placeholder ?? "Path to LoRA weights..."}
        />
        <RangeField label="LoRA Scale" value={loraScale} onChange={onScaleChange} min={0} max={2} step={0.05} />
      </div>
    </FormSection>
  );
}
