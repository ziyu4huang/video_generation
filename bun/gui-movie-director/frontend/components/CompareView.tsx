import React, { useState, useRef, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { GalleryImage } from "../types";
import { runAbTest } from "../api/abTest";
import type { AbTestFeedback } from "../api/abTest";
import { JsonViewer } from "./JsonViewer";
import { toast } from "../utils/toast";
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

  // A/B test: runs metrics + pixel diff + (optional) VLM and emits a feedback
  // JSON (a lean pointer-manifest) the user copies to hand to Claude Code.
  const [abRunning, setAbRunning] = useState(false);
  const [abSkipVlm, setAbSkipVlm] = useState(false);
  const [abResult, setAbResult] = useState<AbTestFeedback | null>(null);
  const [abPanelOpen, setAbPanelOpen] = useState(false);
  const [abIntent, setAbIntent] = useState("");

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

  // A/B analysis. A = left, B = right (stable — independent of the visual Swap).
  // Full (incl VLM) is ~1-3 min; Skip-VLM is ~5s. The result is a lean
  // pointer-manifest the user copies to hand to Claude Code.
  const handleRunAb = useCallback(async () => {
    if (abRunning) return;
    setAbRunning(true);
    setAbResult(null);
    toast.info(`🔬 A/B analyzing${abSkipVlm ? "" : " (incl VLM — ~1-3 min)"}…`);
    try {
      const r = await runAbTest({ a: { url: left.url }, b: { url: right.url }, skipVlm: abSkipVlm });
      if (!r.ok || !r.feedback) {
        toast.error(`A/B failed: ${r.error || "unknown"}`);
      } else {
        setAbResult(r.feedback);
        setAbIntent(r.feedback.intent);
        setAbPanelOpen(true);
        toast.success(`A/B done — lever: ${r.feedback.lever}, verdict: ${r.feedback.verdict.winner}`);
      }
    } catch (err: any) {
      toast.error(`A/B failed: ${err?.message || err}`);
    } finally {
      setAbRunning(false);
    }
  }, [abRunning, abSkipVlm, left.url, right.url]);

  const handleCopyAb = useCallback(() => {
    if (!abResult) return;
    // fold the (possibly edited) intent back into the copied JSON
    const out = { ...abResult, intent: abIntent || abResult.intent };
    navigator.clipboard.writeText(JSON.stringify(out, null, 2))
      .then(() => toast.success("Feedback JSON copied — paste into Claude Code"))
      .catch(() => toast.error("Clipboard copy failed"));
  }, [abResult, abIntent]);

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
              <label className={s.abSkip} title="Skip the slow VLM perceptual scoring (metrics + diff only, ~5s)">
                <input type="checkbox" checked={abSkipVlm} onChange={(e) => setAbSkipVlm(e.target.checked)} />
                Skip VLM
              </label>
              <button
                className={s.headerBtn}
                onClick={handleRunAb}
                disabled={abRunning || left.mediaType === "video" || right.mediaType === "video"}
                title={
                  left.mediaType === "video" || right.mediaType === "video"
                    ? "A/B analysis is image-only — pick two images"
                    : "Run A/B analysis (metrics + pixel diff + VLM) and emit a feedback JSON for Claude Code"
                }
              >{abRunning ? "⏳ A/B…" : "🔬 A/B"}</button>
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

          {abPanelOpen && abResult && (() => {
            const sm = abResult.analysis.signal_metrics || {};
            const pd = abResult.analysis.pixel_diff;
            const vlm = abResult.analysis.vlm_scores;
            const vlmKeys = vlm?.A ? Object.keys(vlm.A).filter((k) => typeof (vlm.A as any)[k] === "number") : [];
            const smKeys = sm.A ? Object.keys(sm.A) : [];
            const win = abResult.verdict.winner;
            return (
              <div className={s.abPanel} onMouseDown={(e) => e.stopPropagation()}>
                <div className={s.abPanelHead}>
                  <span className={s.abPanelTitle}>🔬 A/B Results</span>
                  <span className={s.abBadge} title="auto-detected differing param">lever: {abResult.lever}</span>
                  <span className={`${s.abBadge} ${win === "A" ? s.abWinA : win === "B" ? s.abWinB : s.abWinTie}`}>
                    winner: {win}
                  </span>
                  <button className={s.abClose} onClick={() => setAbPanelOpen(false)} title="Collapse panel">✕</button>
                </div>

                <div className={s.abSection}>
                  <div className={s.abVerdict}>{abResult.verdict.rationale}</div>
                  <div className={s.abWhatToDo}>{abResult.action_hints.what_to_do}</div>
                </div>

                {smKeys.length > 0 && (
                  <div className={s.abSection}>
                    <div className={s.abSectionTitle}>Signal metrics · A=left, B=right</div>
                    <table className={s.abTable}>
                      <thead><tr><th>metric</th><th>A</th><th>B</th><th>win</th></tr></thead>
                      <tbody>
                        {smKeys.map((k) => {
                          const av = (sm.A as any)[k], bv = (sm.B as any)[k], w = (sm.winners as any)?.[k];
                          const fmt = (v: any) => (typeof v === "number" ? v.toFixed(2) : v ?? "—");
                          return (
                            <tr key={k}>
                              <td>{k}</td>
                              <td className={w === "A" ? s.abCellWin : ""}>{fmt(av)}</td>
                              <td className={w === "B" ? s.abCellWin : ""}>{fmt(bv)}</td>
                              <td>{w ?? "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {pd && (
                  <div className={s.abSection}>
                    <div className={s.abSectionTitle}>Pixel diff (A vs B)</div>
                    <div className={s.abMetrics}>
                      SSIM <b>{pd.ssim ?? "—"}</b> · PSNR <b>{pd.psnr_db ?? "—"} dB</b> ·
                      mean|Δ| <b>{pd.mean_abs_diff_per255 ?? "—"}/255</b> · %px&gt;20 <b>{pd.pct_gt20 ?? "—"}%</b>
                    </div>
                  </div>
                )}

                {vlm && (
                  <div className={s.abSection}>
                    <div className={s.abSectionTitle}>VLM scores{vlm.A?.cached || vlm.B?.cached ? " (cached)" : ""}</div>
                    {vlmKeys.length > 0 ? (
                      <table className={s.abTable}>
                        <thead><tr><th>dim</th><th>A</th><th>B</th></tr></thead>
                        <tbody>
                          {vlmKeys.map((k) => (
                            <tr key={k}>
                              <td>{k}</td>
                              <td>{(vlm.A as any)[k]}</td>
                              <td>{(vlm.B as any)?.[k] ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <div className={s.abMetrics}>VLM scores unavailable.</div>}
                  </div>
                )}

                {abResult.diff_heatmap_url && (
                  <div className={s.abSection}>
                    <div className={s.abSectionTitle}>Diff heatmap · A | |A-B|×4 | B</div>
                    <img className={s.abThumb} src={abResult.diff_heatmap_url} alt="A/B diff heatmap" />
                  </div>
                )}

                <div className={s.abSection}>
                  <div className={s.abSectionTitle}>Feedback JSON for Claude Code</div>
                  <input
                    className={s.abIntent}
                    value={abIntent}
                    onChange={(e) => setAbIntent(e.target.value)}
                    placeholder="one-line goal (optional — folded into the JSON)"
                  />
                  <div className={s.abCopyRow}>
                    <button className={s.abCopyBtn} onClick={handleCopyAb}>📋 Copy JSON</button>
                    <span className={s.abHint}>paste into Claude Code — it follows run_path / model_dir for full detail</span>
                  </div>
                  <div className={s.abJson}>
                    <JsonViewer data={{ ...abResult, intent: abIntent || abResult.intent }} defaultOpen={3} />
                  </div>
                </div>
              </div>
            );
          })()}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
