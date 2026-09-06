"use client";

import { useEffect, useRef, useState } from "react";
import { createMacbookScene } from "./macbook-scene.mjs";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function Macbook() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const explodeRef = useRef(0);
  const autoRef = useRef(false);
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const { init, surface } = await import("vgpu");
      const gpu = await init();
      if (disposed) { gpu.dispose(); return; }
      const scene = await createMacbookScene(gpu);
      const s = surface(gpu, canvas, { dpr: [1, 2] });
      scene.resize(s.size[0], s.size[1]);

      const orbit = { yaw: 0.55, pitch: 0.3, dist: 15 };
      let dragging = false;
      let lx = 0, ly = 0;
      const down = (e: PointerEvent) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); };
      const move = (e: PointerEvent) => {
        if (!dragging) return;
        orbit.yaw += (e.clientX - lx) * 0.005;
        orbit.pitch = clamp(orbit.pitch + (e.clientY - ly) * 0.005, 0.05, 1.35);
        lx = e.clientX; ly = e.clientY;
      };
      const up = () => { dragging = false; };
      const wheel = (e: WheelEvent) => {
        e.preventDefault();
        orbit.dist = clamp(orbit.dist * Math.exp(e.deltaY * 0.001), 8, 40);
      };
      canvas.addEventListener("pointerdown", down);
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("wheel", wheel, { passive: false });

      const ro = new ResizeObserver(() => scene.resize(s.size[0], s.size[1]));
      ro.observe(canvas);

      // plain rAF — scene.render() opens its own frame(); frameLoop would nest.
      const t0 = performance.now();
      let raf = 0;
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        if (autoRef.current) {
          const e = 0.5 - 0.5 * Math.cos(t * 0.9);   // assemble ⇄ explode ping-pong
          explodeRef.current = e;
          if (sliderRef.current) sliderRef.current.value = String(e);
        }
        scene.render(t, orbit, explodeRef.current, s);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        canvas.removeEventListener("pointerdown", down);
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("wheel", wheel);
        gpu.dispose();
      };
    })().catch((err) => console.error("macbook init failed:", err));

    return () => { disposed = true; cleanup?.(); };
  }, []);

  const bar: React.CSSProperties = {
    pointerEvents: "none",
    position: "absolute", left: 0, right: 0, bottom: 18,
    display: "flex", gap: 14, alignItems: "center", justifyContent: "center",
    font: "13px -apple-system, system-ui, sans-serif", color: "#333",
  };
  const btn: React.CSSProperties = {
    pointerEvents: "auto", padding: "6px 14px", borderRadius: 999, border: "1px solid #bbb",
    background: auto ? "#0a84ff" : "#fff", color: auto ? "#fff" : "#333", cursor: "pointer",
  };

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: "#e6e7ea" }}>
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      <div style={bar}>
        <button style={btn} onClick={() => setAuto((a) => { autoRef.current = !a; return !a; })}>
          自動拆解
        </button>
        <input
          ref={sliderRef} type="range" min={0} max={1} step={0.01} defaultValue={0}
          style={{ pointerEvents: "auto", width: "min(420px, 55vw)", accentColor: "#0a84ff" }}
          onInput={(e) => {
            autoRef.current = false; setAuto(false);
            explodeRef.current = parseFloat((e.target as HTMLInputElement).value);
          }}
        />
        <span>拆解 explode</span>
      </div>
    </div>
  );
}

export default Macbook;
