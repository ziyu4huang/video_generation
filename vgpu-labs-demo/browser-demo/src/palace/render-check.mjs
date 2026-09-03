// Headless pixel check for the Forbidden City: renders through the SAME
// createPalaceScene the browser tab uses (vgpu/node → Dawn → Metal).
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { init, target } from "vgpu/node";
import { createPalaceScene } from "./palace-scene.mjs";

const W = 1280;
const H = 720;
const gpu = await init();
const canvasTarget = target(gpu, { size: [W, H] });
const scene = await createPalaceScene(gpu);
scene.resize(W, H);
console.log("instances:", scene.stats);

const views = [
  { name: "axis",   yaw: 0.1,  pitch: 0.3,  dist: 64 },  // postcard axial from the south
  { name: "corner", yaw: 2.4,  pitch: 0.42, dist: 72 },  // NE: corner turret + Jingshan
  { name: "close",  yaw: 0.0,  pitch: 0.14, dist: 38 },  // human-eye down the axis
];
for (const v of views) {
  scene.render(3, { yaw: v.yaw, pitch: v.pitch, dist: v.dist }, canvasTarget);
  const pixels = await canvasTarget.read();
  const png = new PNG({ width: W, height: H });
  png.data.set(pixels);
  writeFileSync(new URL(`./check-${v.name}.png`, import.meta.url), PNG.sync.write(png));
  console.log(`wrote check-${v.name}.png`);
}
gpu.dispose();
