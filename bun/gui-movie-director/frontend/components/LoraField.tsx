import { useLoras, type LoraInfo } from "../hooks/useLoras";

export interface LoraRow {
  path: string;
  scale: number;
}

interface Props {
  label: string;
  value: LoraRow[];
  onChange: (rows: LoraRow[]) => void;
}

/**
 * Multi-LoRA editor: a stack of rows, each = an installed-LoRA <select> + a
 * 0–1 scale range + a remove button, plus an "Add LoRA" button. State is an
 * array of {path, scale}; the parent schema's buildParams derives the repeated
 * --lora-path / --lora-scale flags from it.
 */
export function LoraField({ label, value, onChange }: Props) {
  const { loras, loading } = useLoras();

  const update = (i: number, patch: Partial<LoraRow>) =>
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { path: "", scale: 1.0 }]);

  return (
    <div className="form-group">
      <label>{label}</label>
      {loading && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
          Loading LoRAs…
        </div>
      )}
      {!loading && value.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
          No LoRAs selected.
        </div>
      )}
      {value.map((row, i) => (
        <div key={i} className="lora-row">
          <select
            className="lora-select"
            value={row.path}
            onChange={(e) => update(i, { path: e.target.value })}
          >
            <option value="">Select a LoRA…</option>
            {loras.map((l: LoraInfo) => (
              <option key={l.path} value={l.path}>
                {l.name}
                {l.description ? ` — ${l.description}` : ""}
              </option>
            ))}
          </select>
          <input
            type="range"
            className="lora-scale"
            min={0}
            max={1}
            step={0.05}
            value={row.scale}
            onChange={(e) => update(i, { scale: Number(e.target.value) })}
          />
          <span className="lora-scale-val">{row.scale.toFixed(2)}</span>
          <button
            type="button"
            className="lora-remove-btn"
            onClick={() => remove(i)}
            title="Remove LoRA"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="lora-add-btn" onClick={add}>
        + Add LoRA
      </button>
    </div>
  );
}
