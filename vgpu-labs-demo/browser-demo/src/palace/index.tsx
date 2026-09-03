"use client";

import { useEffect, useRef } from "react";
import { createPalaceScene } from "./palace-scene.mjs";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function Palace() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const { init, surface } = await import("vgpu");
      const gpu = await init();
      if (disposed) { gpu.dispose(); return; }
      const scene = await createPalaceScene(gpu);
      const s = surface(gpu, canvas, { dpr: [1, 2] });
      scene.resize(s.size[0], s.size[1]);

      const orbit = { yaw: 0.1, pitch: 0.3, dist: 64 };
      let lastInteraction = performance.now();
      let dragging = false;
      let lx = 0, ly = 0;
      const down = (e: PointerEvent) => {
        dragging = true; lx = e.clientX; ly = e.clientY;
        lastInteraction = performance.now();
        canvas.setPointerCapture(e.pointerId);
      };
      const move = (e: PointerEvent) => {
        if (!dragging) return;
        orbit.yaw += (e.clientX - lx) * 0.005;
        orbit.pitch = clamp(orbit.pitch + (e.clientY - ly) * 0.005, 0.05, 1.35);
        lx = e.clientX; ly = e.clientY;
        lastInteraction = performance.now();
      };
      const up = () => { dragging = false; };
      const wheel = (e: WheelEvent) => {
        e.preventDefault();
        orbit.dist = clamp(orbit.dist * Math.exp(e.deltaY * 0.001), 18, 130);
        lastInteraction = performance.now();
      };
      canvas.addEventListener("pointerdown", down);
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("wheel", wheel, { passive: false });

      const ro = new ResizeObserver(() => scene.resize(s.size[0], s.size[1]));
      ro.observe(canvas);

      // plain rAF — scene.render() opens its own frame(); driving it from
      // vgpu's frameLoop would nest frame(gpu) and throw. Idle cameras drift
      // slowly along the axis so the courtyard keeps moving.
      const t0 = performance.now();
      let prev = t0;
      let raf = 0;
      const tick = () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - prev) / 1000);
        prev = now;
        if (!dragging && now - lastInteraction > 5000) orbit.yaw += dt * 0.02;
        scene.render((now - t0) / 1000, orbit, s);
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
    })().catch((err) => console.error("palace init failed:", err));

    return () => { disposed = true; cleanup?.(); };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
    </div>
  );
}

export default Palace;
