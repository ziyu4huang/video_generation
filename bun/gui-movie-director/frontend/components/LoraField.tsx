import { useLoras, type LoraInfo } from "../hooks/useLoras";

export interface LoraRow {
  path: string;
  scale: number;
}

interface Props {
  label: string;
  value: LoraRow[];
  onChange: (rows: LoraRow[]) => void;
  /** Pipeline tags to filter available LoRAs. undefined = show all; [] = none supported. */
  loraTags?: string[];
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function LoraField({ label, value, onChange, loraTags }: Props) {
  const { loras, loading } = useLoras();

  const filtered: LoraInfo[] =
    loraTags === undefined
      ? loras
      : loraTags.length === 0
        ? []
        : loras.filter((l) => l.pipeline?.some((tag) => loraTags.includes(tag)));

  const updatePath = (i: number, newPath: string) => {
    const lora = filtered.find((l) => l.path === newPath);
    const patch: Partial<LoraRow> = { path: newPath };
    if (lora?.recommended_scale !== undefined) patch.scale = lora.recommended_scale;
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const update = (i: number, patch: Partial<LoraRow>) =>
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { path: "", scale: 1.0 }]);

  const noSupport = loraTags !== undefined && loraTags.length === 0;

  return (
    <div className="form-group">
      <label>{label}</label>
      {loading && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
          Loading LoRAs…
        </div>
      )}
      {noSupport && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
          No LoRA support for the selected pipeline.
        </div>
      )}
      {!loading && !noSupport && value.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
          No LoRAs selected.
        </div>
      )}
      {!noSupport && value.map((row, i) => {
        const selected = filtered.find((l) => l.path === row.path);
        return (
          <div key={i} className="lora-entry">
            <div className="lora-row">
              <select
                className="lora-select"
                value={row.path}
                onChange={(e) => updatePath(i, e.target.value)}
              >
                <option value="">Select a LoRA…</option>
                {filtered.map((l: LoraInfo) => (
                  <option key={l.path} value={l.path} title={l.description}>
                    {l.name}
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
            {selected && row.path && (
              <div className="lora-info">
                {selected.description && (
                  <span className="lora-info-desc">{selected.description}</span>
                )}
                <div className="lora-info-tags">
                  {selected.arch && <span className="lora-tag">{selected.arch}</span>}
                  {selected.format && <span className="lora-tag">{selected.format}</span>}
                  {selected.rank !== undefined && (
                    <span className="lora-tag">rank {selected.rank}</span>
                  )}
                  {selected.size_bytes !== undefined && (
                    <span className="lora-tag">{formatBytes(selected.size_bytes)}</span>
                  )}
                  {selected.recommended_scale !== undefined && (
                    <span className="lora-tag lora-tag-rec">
                      rec. scale {selected.recommended_scale}
                    </span>
                  )}
                  {selected.trigger_words && selected.trigger_words.length > 0 && (
                    <span className="lora-tag lora-tag-trigger">
                      trigger: {selected.trigger_words.join(", ")}
                    </span>
                  )}
                </div>
                {selected.compatible_with && selected.compatible_with.length > 0 && (
                  <div className="lora-info-compat">
                    compat: {selected.compatible_with.map((c) => c.replace(/^[^/]+\//, "")).join(", ")}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {!noSupport && (
        <button type="button" className="lora-add-btn" onClick={add}>
          + Add LoRA
        </button>
      )}
    </div>
  );
}
