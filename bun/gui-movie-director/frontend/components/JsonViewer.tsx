import React, { useState } from "react";
import { formatBytes } from "../utils/format";

// Recursive JSON value renderer with collapsible objects/arrays

function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

function isPath(s: string): boolean {
  return s.startsWith("/") || s.startsWith("~/") || /^[A-Za-z]:\\/.test(s);
}

function isLong(s: string): boolean {
  return s.length > 120;
}

// Check if key name suggests a byte size field
function isSizeKey(key: string): boolean {
  return /size|bytes/i.test(key);
}

// Check if key name suggests a file path
function isPathKey(key: string): boolean {
  return /path|dir|file|output/i.test(key);
}

// Shorten a file path to last N segments
function shortenPath(p: string, segments: number = 3): string {
  const parts = p.split("/");
  if (parts.length <= segments + 1) return p;
  return "…/" + parts.slice(-(segments)).join("/");
}

// Key priority ordering for JsonObject
const KEY_PRIORITY = [
  "command", "action", "label", "method", "status",
  "prompt", "negative_prompt",
  "seed", "steps", "width", "height", "scale",
  "pipeline", "model", "lora", "lora_scale",
  "denoise_strength", "controlnet_type", "controlnet_strength",
  "path", "realpath",
  "size_bytes",
  "elapsed_seconds", "timestamp",
  "error",
];

function sortKeys(keys: string[]): string[] {
  const prioritySet = new Set(KEY_PRIORITY);
  const prioritized = KEY_PRIORITY.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !prioritySet.has(k)).sort();
  return [...prioritized, ...rest];
}

// --- Primitive renderers ---

function renderNull() {
  return <span className="jv-null">null</span>;
}

function renderBool(v: boolean) {
  return <span className="jv-bool">{String(v)}</span>;
}

function renderNumber(v: number, key?: string) {
  // Format byte sizes as human-readable
  if (key && isSizeKey(key)) {
    return <span className="jv-num" title={`${v} bytes`}>{formatBytes(v)}</span>;
  }
  return <span className="jv-num">{v}</span>;
}

function renderString(v: string, key?: string) {
  if (isUrl(v)) {
    return (
      <a className="jv-url" href={v} target="_blank" rel="noopener noreferrer">
        {v}
      </a>
    );
  }
  if (isPath(v)) {
    const short = (key && isPathKey(key) && v.length > 60) ? shortenPath(v) : v;
    return <span className="jv-path" title={v}>{short}</span>;
  }
  if (isLong(v)) {
    return <LongString value={v} />;
  }
  return <span className="jv-string">{v}</span>;
}

function LongString({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return (
      <span className="jv-string jv-string-long" onClick={() => setExpanded(false)}>
        {value}
      </span>
    );
  }
  return (
    <span className="jv-string jv-string-truncated" onClick={() => setExpanded(true)}>
      {value.slice(0, 100)}…
    </span>
  );
}

// --- Object / Array renderers ---

interface JsonValueProps {
  value: unknown;
  depth?: number;
  defaultOpen?: number;
  keyHint?: string;
  hideNull?: boolean;
}

function JsonArray({ value, depth = 0, defaultOpen = 2, hideNull }: JsonValueProps) {
  const arr = value as unknown[];
  const [open, setOpen] = useState(depth < defaultOpen);

  return (
    <div className="jv-collapsible">
      <span className="jv-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} <span className="jv-bracket">[</span>
        <span className="jv-count">{arr.length}</span>
        {!open && <span className="jv-bracket">]</span>}
      </span>
      {open && (
        <>
          <div className="jv-indent">
            {arr.map((item, i) => (
              <div key={i} className="jv-row">
                <span className="jv-index">{i}</span>
                <span className="jv-colon">:</span>
                <JsonValue value={item} depth={depth + 1} defaultOpen={defaultOpen} hideNull={hideNull} />
              </div>
            ))}
          </div>
          <span className="jv-bracket">]</span>
        </>
      )}
    </div>
  );
}

function JsonObject({ value, depth = 0, defaultOpen = 2, hideNull }: JsonValueProps) {
  const obj = value as Record<string, unknown>;
  const [open, setOpen] = useState(depth < defaultOpen);
  const [showAll, setShowAll] = useState(false);
  const keys = sortKeys(Object.keys(obj));

  const hiddenKeys = hideNull && !showAll
    ? keys.filter((k) => obj[k] === null || obj[k] === undefined)
    : [];
  const visibleKeys = hideNull && !showAll
    ? keys.filter((k) => obj[k] !== null && obj[k] !== undefined)
    : keys;

  return (
    <div className="jv-collapsible">
      <span className="jv-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} <span className="jv-bracket">{"{"}</span>
        <span className="jv-count">{keys.length}</span>
        {!open && <span className="jv-bracket">{"}"}</span>}
      </span>
      {open && (
        <>
          <div className="jv-indent">
            {visibleKeys.map((key) => (
              <div key={key} className="jv-row">
                <span className="jv-key">{key}</span>
                <span className="jv-colon">:</span>
                <JsonValue value={obj[key]} depth={depth + 1} defaultOpen={defaultOpen} keyHint={key} hideNull={hideNull} />
              </div>
            ))}
            {hiddenKeys.length > 0 && (
              <div className="jv-show-all" onClick={() => setShowAll(!showAll)}>
                {showAll ? "▾ Hide null values" : `▸ Show all (${hiddenKeys.length} null)`}
              </div>
            )}
          </div>
          <span className="jv-bracket">{"}"}</span>
        </>
      )}
    </div>
  );
}

export function JsonValue({ value, depth = 0, defaultOpen = 2, keyHint, hideNull }: JsonValueProps) {
  if (value === null || value === undefined) return renderNull();
  if (typeof value === "boolean") return renderBool(value);
  if (typeof value === "number") return renderNumber(value, keyHint);
  if (typeof value === "string") return renderString(value, keyHint);
  if (Array.isArray(value)) return <JsonArray value={value} depth={depth} defaultOpen={defaultOpen} hideNull={hideNull} />;
  if (typeof value === "object") return <JsonObject value={value} depth={depth} defaultOpen={defaultOpen} hideNull={hideNull} />;
  return <span className="jv-string">{String(value)}</span>;
}

interface JsonViewerProps {
  data: unknown;
  title?: string;
  defaultOpen?: number;
  hideNull?: boolean;
}

export function JsonViewer({ data, title, defaultOpen = 2, hideNull }: JsonViewerProps) {
  return (
    <div className="json-viewer">
      {title && <div className="jv-title">{title}</div>}
      <JsonValue value={data} depth={0} defaultOpen={defaultOpen} hideNull={hideNull} />
    </div>
  );
}
