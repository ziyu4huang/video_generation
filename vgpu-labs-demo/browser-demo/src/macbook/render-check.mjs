// Headless pixel check for the MacBook teardown: renders through the SAME
// createMacbookScene the browser tab uses (vgpu/node → Dawn → Metal) at three
// explode factors.
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { init, target } from "vgpu/node";
import { createMacbookScene } from "./macbook-scene.mjs";

const W = 1280;
const H = 720;
const gpu = await init();
const canvasTarget = target(gpu, { size: [W, H] });
const scene = await createMacbookScene(gpu);
scene.resize(W, H);
console.log("instances:", scene.stats);

const cam = { yaw: 0.55, pitch: 0.3, dist: 16 };
for (const e of [0, 0.55, 1]) {
  scene.render(2, cam, e, canvasTarget);
  const pixels = await canvasTarget.read();
  const png = new PNG({ width: W, height: H });
  png.data.set(pixels);
  const name = `check-e${String(e).replace(".", "_")}.png`;
  writeFileSync(new URL(`./${name}`, import.meta.url), PNG.sync.write(png));
  console.log(`wrote ${name}`);
}
gpu.dispose();
