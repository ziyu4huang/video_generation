import React, { useState, useRef, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { GalleryImage } from "../types";
import s from "./CompareView.module.css";

interface CompareViewProps {
  left: GalleryImage;
  right: GalleryImage;
  onClose: () => void;
}

/**
 * Compact label from run params, so the 4-bit vs 8-bit transformer (and the
 * fixed seed/steps/cfg) are visible at a glance above each pane:
 *   "ernie-redmix-redzit15-8bit · seed 777 · 8 steps · cfg 1"
 */
function getCompareLabel(img: GalleryImage): string {
  const r = (img.run ?? null) as Record<string, any> | null;
  if (!r) return img.name;
  const parts: string[] = [];
  if (r.transformer) parts.push(String(r.transformer));
  if (r.seed != null) parts.push(`seed ${r.seed}`);
  if (r.steps != null) parts.push(`${r.steps} steps`);
  if (r.cfg_scale != null) parts.push(`cfg ${r.cfg_scale}`);
  return parts.join(" · ") || img.name;
}

function paneSrc(img: GalleryImage): string {
  return img.mediaType === "video" ? (img.thumbnailUrl || img.url) : img.url;
}

/**
 * Full-screen side-by-side compare overlay. Two panes share ONE zoom/pan
 * state so scrolling/dragging moves both images in lockstep — the point is to
 * compare the same region of two near-identical renders (e.g. 4-bit vs 8-bit).
 *
 * Zoom/pan mirrors ImagePreview.tsx, but the wheel zoom is unguarded (no
 * ctrl/meta required): the compare surface has nothing to scroll, and zooming
 * into detail is the primary intent.
 */
export function CompareView({ left, right, onClose }: CompareViewProps) {
  const [swapped, setSwapped] = useState(false);
  const a = swapped ? right : left;
  const b = swapped ? left : right;

  // Shared zoom / pan
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const didDrag = useRef(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  // View mode: side-by-side (split) or draggable wipe overlay.
  const [mode, setMode] = useState<"split" | "wipe">("split");
  // Wipe divider position (percent across the surface, 0-100).
  const [dividerX, setDividerX] = useState(50);
  const [isWiping, setIsWiping] = useState(false);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Wipe divider drag. Uses window listeners so the handle keeps tracking even
  // when the pointer leaves the surface; mousedown also jumps the divider to the
  // click position for click-to-position.
  const moveDividerTo = useCallback((clientX: number) => {
    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setDividerX(Math.max(0, Math.min(100, pct)));
  }, []);

  const startWipe = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    moveDividerTo(e.clientX);
    setIsWiping(true);
  }, [moveDividerTo]);

  useEffect(() => {
    if (!isWiping) return;
    const onMove = (e: MouseEvent) => moveDividerTo(e.clientX);
    const onUp = () => setIsWiping(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isWiping, moveDividerTo]);

  // Wheel zoom (non-passive to allow preventDefault)
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.88 : 1 / 0.88;
      setZoom((prev) => Math.max(0.5, Math.min(8, prev * delta)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1 || e.button !== 0) return;
    e.preventDefault();
    didDrag.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setIsPanning(true);
  }, [zoom, pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [isPanning]);

  const handleMouseUp = useCallback(() => setIsPanning(false), []);
  const handleDoubleClick = useCallback(() => resetView(), [resetView]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (zoom !== 1 || isPanning || didDrag.current) {
      didDrag.current = false;
      return;
    }
    onClose();
  }, [zoom, isPanning, onClose]);

  const zoomBy = useCallback((factor: number) => {
    setZoom((prev) => {
      const z = Math.max(0.5, Math.min(8, prev * factor));
      if (z === 1) setPan({ x: 0, y: 0 });
      return z;
    });
  }, []);

  const cursorMod = zoom > 1 ? (isPanning ? s.panning : s.zoomed) : "";
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return (
    <Dialog.Root open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content
          className={s.overlay}
          onClick={handleOverlayClick}
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="sr-only">Compare images</Dialog.Title>

          <div className={s.header} onMouseDown={(e) => e.stopPropagation()}>
            <div className={s.headerLeft}>
              <span className={s.headerTitle}>⚖ Compare</span>
              <div className={s.modeToggle} role="group" aria-label="Compare layout">
                <button
                  className={`${s.modeBtn}${mode === "split" ? " " + s.modeBtnActive : ""}`}
                  onClick={() => setMode("split")}
                  title="Two panes side by side"
                >Side by side</button>
                <button
                  className={`${s.modeBtn}${mode === "wipe" ? " " + s.modeBtnActive : ""}`}
                  onClick={() => setMode("wipe")}
                  title="Draggable wipe overlay (same coordinates)"
                >Wipe</button>
              </div>
            </div>
            <div className={s.headerRight}>
              <button className={s.headerBtn} onClick={() => setSwapped((v) => !v)} title="Swap left/right">⇄ Swap</button>
              <button className={s.headerBtn} onClick={onClose} title="Close (Esc)">✕ Close</button>
            </div>
          </div>

          <div
            ref={surfaceRef}
            className={`${s.surface}${cursorMod ? " " + cursorMod : ""}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDoubleClick={handleDoubleClick}
          >
            {mode === "split" ? (
              <>
                <div className={s.pane}>
                  <img src={paneSrc(a)} alt={a.name} className={s.media} style={{ transform }} draggable={false} />
                  <div className={s.paneLabel}>{getCompareLabel(a)}</div>
                </div>
                <div className={s.divider} aria-hidden="true" />
                <div className={s.pane}>
                  <img src={paneSrc(b)} alt={b.name} className={s.media} style={{ transform }} draggable={false} />
                  <div className={s.paneLabel}>{getCompareLabel(b)}</div>
                </div>
              </>
            ) : (
              <div className={s.wipeStage}>
                {/* base = right image (b), shown in full */}
                <img src={paneSrc(b)} alt={b.name} className={s.wipeImg} style={{ transform }} draggable={false} />
                {/* top = left image (a), clipped to the left of the divider so the
                    same screen coordinate shows a on the left, b on the right */}
                <img
                  src={paneSrc(a)}
                  alt={a.name}
                  className={s.wipeImg}
                  style={{ transform, clipPath: `inset(0 ${100 - dividerX}% 0 0)` }}
                  draggable={false}
                />
                <div className={s.wipeLabelLeft}>{getCompareLabel(a)}</div>
                <div className={s.wipeLabelRight}>{getCompareLabel(b)}</div>
                <div className={s.wipeHandle} style={{ left: `${dividerX}%` }} onMouseDown={startWipe}>
                  <div className={s.wipeGrip} aria-hidden="true">⇄</div>
                </div>
              </div>
            )}
          </div>

          <div className={s.toolbar} onMouseDown={(e) => e.stopPropagation()}>
            <button className={s.zoomBtn} onClick={(e) => { e.stopPropagation(); zoomBy(1 / 1.5); }} title="Zoom out" aria-label="Zoom out">−</button>
            <span className={s.zoomLabel}>{zoom.toFixed(1)}×</span>
            <button className={s.zoomBtn} onClick={(e) => { e.stopPropagation(); zoomBy(1.5); }} title="Zoom in" aria-label="Zoom in">+</button>
            <span className={s.zoomDivider} aria-hidden="true" />
            <button
              className={`${s.zoomBtn}${zoom === 1 ? " " + s.zoomBtnActive : ""}`}
              onClick={(e) => { e.stopPropagation(); resetView(); }}
              title="Reset (1×)"
            >1×</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
