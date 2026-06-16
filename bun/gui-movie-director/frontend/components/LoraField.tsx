import { useState } from "react";
import { useLoras, type LoraInfo } from "../hooks/useLoras";

export interface LoraRow {
  path: string;
  scale: number;
}

interface Props {
  label: string;
  value: LoraRow[];
  onChange: (rows: LoraRow[]) => void;
  loraTags?: string[];
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

function CopyBtn({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const handleClick = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      className={`lora-copy-btn${copied ? " lora-copy-btn--ok" : ""}`}
      onClick={handleClick}
      title={title ?? text}
    >
      {copied ? "✓" : "copy path"}
    </button>
  );
}

function LoraInfoPanel({ lora }: { lora: LoraInfo }) {
  const shortCompat = lora.compatible_with?.map((c) => c.replace(/^[^/]+\//, ""));
  const originalSize = lora.converted_from?.size_bytes;
  const originalFmt = lora.converted_from?.format;

  return (
    <div className="lora-info">
      {/* Header: description + copy path */}
      <div className="lora-info-header">
        {lora.description && (
          <span className="lora-info-desc">{lora.description}</span>
        )}
        <CopyBtn text={lora.path} title={lora.path} />
      </div>

      {/* Tags row */}
      <div className="lora-info-tags">
        {lora.arch && <span className="lora-tag">{lora.arch}</span>}
        {lora.format && <span className="lora-tag">{lora.format}</span>}
        {lora.rank !== undefined && (
          <span className="lora-tag">rank {lora.rank}</span>
        )}
        {lora.folder_size_bytes !== undefined && lora.folder_size_bytes > 0 && (
          <span className="lora-tag" title="Folder size on disk">
            {formatBytes(lora.folder_size_bytes)}
          </span>
        )}
        {lora.size_bytes !== undefined && originalSize !== undefined && (
          <span className="lora-tag lora-tag-dim" title={`Original ${originalFmt ?? "bf16"}: ${formatBytes(originalSize)}`}>
            {formatBytes(lora.size_bytes)} ← {formatBytes(originalSize)}
          </span>
        )}
        {lora.recommended_scale !== undefined && (
          <span className="lora-tag lora-tag-rec" title="Recommended scale">
            rec. {lora.recommended_scale}
          </span>
        )}
        {lora.created_at && (
          <span className="lora-tag lora-tag-dim" title="Added">
            {formatDate(lora.created_at)}
          </span>
        )}
      </div>

      {/* Trigger words */}
      {lora.trigger_words && lora.trigger_words.length > 0 && (
        <div className="lora-info-row">
          <span className="lora-info-key">trigger</span>
          <span className="lora-tag lora-tag-trigger">{lora.trigger_words.join(", ")}</span>
        </div>
      )}

      {/* Source */}
      {lora.source && (
        <div className="lora-info-row">
          <span className="lora-info-key">source</span>
          {lora.source_url ? (
            <a
              href={lora.source_url}
              target="_blank"
              rel="noreferrer"
              className="lora-info-link"
            >
              {lora.source} ↗
            </a>
          ) : (
            <span className="lora-info-val">{lora.source}</span>
          )}
        </div>
      )}

      {/* Compatible models */}
      {shortCompat && shortCompat.length > 0 && (
        <div className="lora-info-row">
          <span className="lora-info-key">compat</span>
          <span className="lora-info-val">{shortCompat.join(", ")}</span>
        </div>
      )}

      {/* Weight file */}
      {lora.weight_file && (
        <div className="lora-info-row">
          <span className="lora-info-key">file</span>
          <span className="lora-info-val lora-info-mono">{lora.weight_file}</span>
        </div>
      )}

      {/* Test prompt */}
      {lora.test_prompt && (
        <div className="lora-info-row">
          <span className="lora-info-key">test</span>
          <span className="lora-info-val lora-info-prompt">"{lora.test_prompt}"</span>
        </div>
      )}

      {/* Notes */}
      {lora.notes && (
        <div className="lora-info-row">
          <span className="lora-info-key">notes</span>
          <span className="lora-info-val">{lora.notes}</span>
        </div>
      )}
    </div>
  );
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
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Loading LoRAs…</div>
      )}
      {noSupport && (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          No LoRA support for the selected pipeline.
        </div>
      )}
      {!loading && !noSupport && value.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No LoRAs selected.</div>
      )}
      {!noSupport &&
        value.map((row, i) => {
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
              {selected && row.path && <LoraInfoPanel lora={selected} />}
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
