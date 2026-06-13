import React, { useState } from "react";

// Shared field components for all command forms

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
  historyId?: string;
  history?: string[];
}

export function TextField({ label, value, onChange, placeholder, multiline, required, historyId, history }: TextFieldProps) {
  return (
    <div className="form-group">
      <label>{label}{required && " *"}</label>
      {historyId && history && history.length > 0 && (
        <datalist id={historyId}>
          {history.map((v, i) => <option key={i} value={v} />)}
        </datalist>
      )}
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          list={historyId && history?.length ? historyId : undefined}
        />
      )}
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number | undefined;
  onChange: (val: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export function NumberField({ label, value, onChange, min, max, step, placeholder }: NumberFieldProps) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
      />
    </div>
  );
}

interface RangeFieldProps {
  label: string;
  value: number;
  onChange: (val: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export function RangeField({ label, value, onChange, min = 0, max = 1, step = 0.05 }: RangeFieldProps) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <div className="range-row">
        <input
          type="range"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          min={min}
          max={max}
          step={step}
        />
        <span className="range-value">{value.toFixed(2)}</span>
      </div>
    </div>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: { value: string; label: string }[];
}

export function SelectField({ label, value, onChange, options }: SelectFieldProps) {
  return (
    <div className="form-group">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface ToggleFieldProps {
  label: string;
  checked: boolean;
  onChange: (val: boolean) => void;
}

export function ToggleField({ label, checked, onChange }: ToggleFieldProps) {
  return (
    <div className="toggle-group">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        id={`toggle-${label.replace(/\s+/g, "-")}`}
      />
      <label htmlFor={`toggle-${label.replace(/\s+/g, "-")}`}>{label}</label>
    </div>
  );
}
