import React, { useState, useEffect, useRef, useCallback } from "react";
import s from "./DomInspector.module.css";
import { inspectElement } from "../utils/inspectElement";
import { getReactInfo } from "../utils/getReactInfo";
import { getSourcePath } from "../utils/getSourcePath";

interface InspectData {
  element: ReturnType<typeof inspectElement>;
  react: ReturnType<typeof getReactInfo>;
  source: { filePath: string | null };
  page: { url: string };
}

export function DomInspector() {
  const [isActive, setIsActive] = useState(false);
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null);
  const [selectedData, setSelectedData] = useState<InspectData | null>(null);
  const [copied, setCopied] = useState(false);
  const inspectorRef = useRef<HTMLDivElement>(null);

  // Toggle inspect mode
  const toggleActive = useCallback(() => {
    setIsActive((prev) => !prev);
    setHoveredRect(null);
    setSelectedData(null);
  }, []);

  // Mouse move handler — highlight element under cursor
  useEffect(() => {
    if (!isActive) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Ignore inspector's own elements
      const target = e.target as Element;
      if (inspectorRef.current?.contains(target)) return;

      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && !inspectorRef.current?.contains(el)) {
        setHoveredRect(el.getBoundingClientRect());
      } else {
        setHoveredRect(null);
      }
    };

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (inspectorRef.current?.contains(target)) return;

      e.preventDefault();
      e.stopPropagation();

      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || inspectorRef.current?.contains(el)) return;

      const elementInfo = inspectElement(el);
      const reactInfo = getReactInfo(el);
      const sourcePath = getSourcePath(reactInfo.componentName);

      setSelectedData({
        element: elementInfo,
        react: reactInfo,
        source: { filePath: sourcePath },
        page: { url: window.location.href },
      });
      setHoveredRect(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedData) {
          setSelectedData(null);
        } else {
          setIsActive(false);
          setHoveredRect(null);
        }
      }
    };

    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isActive, selectedData]);

  // Copy handler
  const handleCopy = useCallback(() => {
    if (!selectedData) return;
    const json = JSON.stringify(selectedData, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [selectedData]);

  // Dismiss modal
  const dismissModal = useCallback(() => {
    setSelectedData(null);
  }, []);

  return (
    <div ref={inspectorRef} style={{ all: "initial" }}>
      {/* Toggle button */}
      <button
        className={`${s.inspectorToggle} ${isActive ? s.active : ""}`}
        onClick={toggleActive}
        title={isActive ? "Exit inspect mode (Esc)" : "Inspect element"}
      >
        🔍
      </button>

      {/* Hover highlight overlay */}
      {isActive && hoveredRect && (
        <div
          className={s.inspectorHighlight}
          style={{
            top: hoveredRect.top,
            left: hoveredRect.left,
            width: hoveredRect.width,
            height: hoveredRect.height,
          }}
        />
      )}

      {/* Detail modal */}
      {selectedData && (
        <div className={s.inspectorModalBackdrop} onClick={dismissModal}>
          <div className={s.inspectorModal} onClick={(e) => e.stopPropagation()}>
            <div className={s.inspectorModalHeader}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)" }}>
                Element Inspector
              </span>
              <button className={s.inspectorModalClose} onClick={dismissModal}>✕</button>
            </div>
            <pre className={s.inspectorModalJson}>
              {JSON.stringify(selectedData, null, 2)}
            </pre>
            <div className={s.inspectorModalActions}>
              <button className="btn btn-primary" onClick={handleCopy} style={{ fontSize: 12 }}>
                {copied ? "✓ Copied!" : "Copy to Clipboard"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
