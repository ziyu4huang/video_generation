// Headless pixel check for the solar system: renders two frames through the
// SAME createSolarScene the browser tab uses (vgpu/node → Dawn → Metal) and
// writes PNGs for visual inspection.
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { init, target } from "vgpu/node";
import { createSolarScene } from "./solar-scene.mjs";

const W = 1280;
const H = 720;
const gpu = await init();
const canvasTarget = target(gpu, { size: [W, H] });
const scene = await createSolarScene(gpu);
scene.resize(W, H);

for (const t of [0, 45]) {
  scene.render(t, { yaw: 0.65, pitch: 0.42, dist: 30 }, canvasTarget);
  const pixels = await canvasTarget.read();
  const png = new PNG({ width: W, height: H });
  png.data.set(pixels);
  writeFileSync(new URL(`./check-t${t}.png`, import.meta.url), PNG.sync.write(png));
  console.log(`wrote check-t${t}.png (${pixels.length} bytes)`);
}
gpu.dispose();
