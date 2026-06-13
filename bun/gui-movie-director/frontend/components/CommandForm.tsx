import React, { useState } from "react";
import type { CommandSchema, FieldDef } from "../schemas/types";
import { TextField, NumberField, RangeField, SelectField, ToggleField } from "./FieldComponents";
import { FileUpload } from "./FileUpload";
import { InlineError } from "./InlineError";
import { FormSection } from "./FormSection";
import { useDefaultState } from "../hooks/useDefaultState";
import { useFieldHistory } from "../hooks/useFieldHistory";

interface CommandFormProps {
  schema: CommandSchema;
  onJobStart: (opts: { jobId: string; command: string }) => void;
  loading: boolean;
  commandPrefix?: string;
  extraActions?: React.ReactNode;
}

/** Extract defaults from all field definitions */
function buildDefaults(sections: CommandSchema["sections"]): Record<string, any> {
  const defaults: Record<string, any> = {};
  for (const section of sections) {
    for (const field of section.fields) {
      if ("default" in field && field.default !== undefined) {
        defaults[field.key] = field.default;
      }
    }
  }
  return defaults;
}

/** Full-width field types that start their own row */
function isFullWidth(field: FieldDef): boolean {
  return field.type === "prompt" || field.type === "image" || field.type === "images";
}

/**
 * Group fields into rows. Full-width fields get their own row.
 * Other fields are grouped up to 3 per row.
 * Fields with `visible` predicate that return false are filtered out.
 */
function groupIntoRows(fields: FieldDef[], state: Record<string, any>): FieldDef[][] {
  const visible = fields.filter((f) => !f.visible || f.visible(state));
  const rows: FieldDef[][] = [];
  let current: FieldDef[] = [];

  for (const field of visible) {
    if (isFullWidth(field)) {
      if (current.length > 0) {
        rows.push(current);
        current = [];
      }
      rows.push([field]);
    } else {
      current.push(field);
      if (current.length >= 3) {
        rows.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

export function CommandForm({ schema, onJobStart, loading, commandPrefix, extraActions }: CommandFormProps) {
  const { state, setField } = useDefaultState(schema.action, buildDefaults(schema.sections));
  const [error, setError] = useState<string | null>(null);

  // Collect prompt fields for history tracking
  const promptFields = schema.sections.flatMap((s) =>
    s.fields.filter((f) => f.type === "prompt" || f.type === "text")
  );
  const promptHistories = promptFields.map((f) => ({
    field: f,
    // Each hook call must be unconditional — we use the field key as stable id
    // eslint-disable-next-line react-hooks/rules-of-hooks
    ...useFieldHistory(schema.action, f.key),
  }));

  const getHistory = (fieldKey: string) =>
    promptHistories.find((h) => h.field.key === fieldKey) ?? null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const params = schema.buildParams ? schema.buildParams(state) : { ...state };
      const prefix = commandPrefix ?? "image";
      const command = `${prefix} ${schema.action}`;
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: schema.action, command, params }),
      });
      const data = await res.json();
      if (data.jobId) {
        // Save prompt/text field values to history
        for (const { field, push } of promptHistories) {
          const val = state[field.key];
          if (typeof val === "string" && val.trim()) push(val);
        }
        onJobStart({ jobId: data.jobId, command });
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      setError(`Failed to start job: ${err}`);
    }
  };

  const renderField = (field: FieldDef) => {
    switch (field.type) {
      case "prompt": {
        const hist = getHistory(field.key);
        return (
          <TextField
            key={field.key}
            label={field.required ? "Prompt *" : "Prompt"}
            value={state[field.key] ?? ""}
            onChange={(v) => setField(field.key, v)}
            placeholder={field.placeholder}
            multiline
            required={field.required}
            historyId={`hist-${schema.action}-${field.key}`}
            history={hist?.history}
          />
        );
      }
      case "text": {
        const hist = getHistory(field.key);
        return (
          <TextField
            key={field.key}
            label={field.label}
            value={state[field.key] ?? ""}
            onChange={(v) => setField(field.key, v)}
            placeholder={field.placeholder}
            multiline={field.multiline}
            historyId={`hist-${schema.action}-${field.key}`}
            history={hist?.history}
          />
        );
      }
      case "number":
        return (
          <NumberField
            key={field.key}
            label={field.label}
            value={state[field.key]}
            onChange={(v) => setField(field.key, v ?? field.default)}
            min={field.min}
            max={field.max}
            step={field.step}
          />
        );
      case "range":
        return (
          <RangeField
            key={field.key}
            label={field.label}
            value={state[field.key] ?? field.default ?? 0}
            onChange={(v) => setField(field.key, v)}
            min={field.min}
            max={field.max}
            step={field.step}
          />
        );
      case "select":
        return (
          <SelectField
            key={field.key}
            label={field.label}
            value={state[field.key] ?? field.default ?? ""}
            onChange={(v) => setField(field.key, v)}
            options={field.options}
          />
        );
      case "toggle":
        return (
          <ToggleField
            key={field.key}
            label={field.label}
            checked={state[field.key] ?? field.default ?? false}
            onChange={(v) => setField(field.key, v)}
          />
        );
      case "image":
        return (
          <div key={field.key} className="form-group">
            <label>{field.label}{field.required && " *"}</label>
            <FileUpload value={state[field.key] ?? null} onChange={(v) => setField(field.key, v)} />
          </div>
        );
      case "images":
        return (
          <div key={field.key} className="form-group">
            <label>{field.label}</label>
            <FileUpload
              value={null}
              onChange={(v) => {
                if (v) setField(field.key, [...(state[field.key] ?? []), v]);
              }}
              multiple
            />
            {Array.isArray(state[field.key]) && state[field.key].length > 0 && (
              <div style={{ marginTop: 8 }}>
                <label style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {state[field.key].length} image(s) selected
                </label>
                <ul style={{ marginTop: 4, paddingLeft: 16, fontSize: 12, color: "var(--text)" }}>
                  {state[field.key].map((img: string, i: number) => (
                    <li key={i}>{img.split("/").pop()}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {schema.sections.map((section) => (
        <FormSection key={section.title} title={section.title}>
          {groupIntoRows(section.fields, state).map((row, ri) => {
            const single = row.length === 1 && isFullWidth(row[0]);
            if (single) {
              // Full-width field — no form-row wrapper, or with toggles in flex column
              const field = row[0];
              if (field.type === "toggle") {
                return (
                  <div key={ri} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {row.map(renderField)}
                  </div>
                );
              }
              return <React.Fragment key={ri}>{renderField(field)}</React.Fragment>;
            }
            // Normal row with multiple fields
            if (row.every((f) => f.type === "toggle")) {
              return (
                <div key={ri} style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  {row.map(renderField)}
                </div>
              );
            }
            return (
              <div key={ri} className="form-row">
                {row.map(renderField)}
              </div>
            );
          })}
        </FormSection>
      ))}
      <div className="btn-row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={loading || schema.isDisabled(state)}
        >
          {loading ? (
            <>
              <span className="spinner" /> {schema.runningLabel}
            </>
          ) : (
            schema.submitLabel
          )}
        </button>
      </div>
      {extraActions}
      <InlineError message={error} onDismiss={() => setError(null)} />
    </form>
  );
}
