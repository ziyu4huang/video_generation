import React, { useState } from "react";
import type { CommandSchema, FieldDef, Hint } from "../schemas/types";
import { TextField, NumberField, RangeField, SelectField, ToggleField } from "./FieldComponents";
import { FileUpload } from "./FileUpload";
import { LoraField } from "./LoraField";
import { InlineError } from "./InlineError";
import { FormSection } from "./FormSection";
import { useDefaultState } from "../hooks/useDefaultState";
import { useAllFieldHistories } from "../hooks/useFieldHistory";
import { PIPELINE_TO_LORA_TAGS } from "../../schemas/shared";
import { runJob } from "../api/jobs";
import { BUILTIN_PROMPTS } from "../data/builtinPrompts";

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
  return field.type === "prompt" || field.type === "image" || field.type === "images" || field.type === "loras";
}

/**
 * Enumerate currently-visible required fields that are still empty,
 * so the disabled submit button can explain what to do first.
 */
function missingRequiredFields(schema: CommandSchema, state: Record<string, any>): string[] {
  const missing: string[] = [];
  for (const section of schema.sections) {
    for (const field of section.fields) {
      // Only prompt/image fields declare `required` in FieldDef.
      if (field.type !== "prompt" && field.type !== "image") continue;
      if (!field.required) continue;
      if (field.visible && !field.visible(state)) continue;
      if (state[field.key]) continue;
      // prompt fields render under the label "Prompt"; image fields carry field.label
      missing.push(field.type === "prompt" ? "Prompt" : field.label);
    }
  }
  return missing;
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

/**
 * A field's hint may be a plain string or a function of the current state.
 * Called for every render of a select/toggle, so it must tolerate a field with
 * no hint at all (most of them).
 */
function resolveHint(
  field: FieldDef & { hint?: Hint },
  state: Record<string, any>,
  inputDims: { w: number; h: number } | null,
): string | undefined {
  const h = field.hint;
  return typeof h === "function" ? h(state, { inputDims }) : h;
}

export function CommandForm({ schema, onJobStart, loading, commandPrefix, extraActions }: CommandFormProps) {
  const { state, setField, serverDefaults } = useDefaultState(schema.action, buildDefaults(schema.sections));
  // Input-image pixel dims (from FileUpload.onImageDimensions). Kept OUT of form
  // state so it never reaches buildParams/CLI args — purely for UI hints (e.g.
  // Purify's computed output-size hint next to the Resolution selector).
  const [inputDims, setInputDims] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const promptFields = schema.sections.flatMap((s) =>
    s.fields.filter((f) => f.type === "prompt" || f.type === "text")
  );
  const fieldHistories = useAllFieldHistories(
    schema.action,
    promptFields.map((f) => f.key)
  );
  const getHistory = fieldHistories.getHistory;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const params = schema.buildParams ? schema.buildParams(state) : { ...state };
      const prefix = commandPrefix ?? "image";
      const command = `${prefix} ${schema.action}`;
      const data = await runJob(schema.action, params);
      if (data.jobId) {
        for (const f of promptFields) {
          const val = state[f.key];
          if (typeof val === "string" && val.trim()) fieldHistories.push(f.key, val);
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
            presets={BUILTIN_PROMPTS}
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
            placeholder={field.placeholder}
            compact={field.compact}
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
      case "select": {
        // Dynamic choices (e.g. the Transformer dropdown) come from serverDefaults,
        // which is loaded from run.py — never hardcoded in the schema. Entries may
        // carry a `pipeline` tag so the list can be filtered by the active pipeline.
        // "auto" pipeline is treated as "zimage" for transformer filtering purposes
        // (backend resolves auto → zimage at runtime).
        let options = field.options ?? [];
        let isLoading = false;
        if (field.choicesFrom) {
          const all = (serverDefaults as Record<string, any> | null)?.[field.choicesFrom] as
            { value: string; label: string; pipeline?: string }[] | undefined;
          if (all) {
            const activePipeline = state.pipeline === "auto" ? "zimage" : state.pipeline;
            options = all
              .filter((c) => !c.pipeline || c.pipeline === activePipeline)
              .map((c) => ({ value: c.value, label: c.label }));
          } else {
            isLoading = true;
          }
        }
        return (
          <SelectField
            key={field.key}
            label={field.label}
            value={state[field.key] ?? field.default ?? ""}
            onChange={(v) => setField(field.key, v)}
            options={options}
            loading={isLoading}
            hint={resolveHint(field, state, inputDims)}
          />
        );
      }
      case "toggle":
        return (
          <ToggleField
            key={field.key}
            label={field.label}
            checked={state[field.key] ?? field.default ?? false}
            onChange={(v) => setField(field.key, v)}
            hint={resolveHint(field, state, inputDims)}
          />
        );
      case "image":
        return (
          <div key={field.key} className="form-group">
            <label>{field.label}{field.required && " *"}</label>
            <FileUpload
              value={state[field.key] ?? null}
              onChange={(v) => { setField(field.key, v); if (!v) setInputDims(null); }}
              onImageDimensions={(w, h) => setInputDims({ w, h })}
            />
          </div>
        );
      case "loras": {
        // Prefer static loraTags from the schema field; fall back to
        // PIPELINE_TO_LORA_TAGS when the form has a live "pipeline" picker.
        const tags: string[] | undefined =
          field.loraTags !== undefined
            ? field.loraTags
            : state.pipeline !== undefined
              ? PIPELINE_TO_LORA_TAGS[state.pipeline as string]
              : undefined;
        return (
          <LoraField
            key={field.key}
            label={field.label}
            value={state[field.key] ?? []}
            onChange={(rows) => setField(field.key, rows)}
            loraTags={tags}
          />
        );
      }
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
              // Full-width field (prompt/image/images/loras) — render with no
              // form-row wrapper. toggle is never full-width (see isFullWidth),
              // so single-toggle rows fall through to the all-toggle branch
              // below; this block never receives a toggle.
              return <React.Fragment key={ri}>{renderField(row[0])}</React.Fragment>;
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
        {extraActions}
      </div>
      {(() => {
        const disabled = !loading && schema.isDisabled(state);
        if (!disabled) return null;
        const missing = missingRequiredFields(schema, state);
        if (missing.length === 0) return null;
        const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
        return (
          <p className="submit-hint">
            Add {list} to continue.
          </p>
        );
      })()}
      <InlineError message={error} onDismiss={() => setError(null)} />
    </form>
  );
}
