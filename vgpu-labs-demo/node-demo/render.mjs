// Headless vgpu demo: same `effect`/`target` API as the browser, but rendered
// offscreen through the Dawn/Metal adapter in plain Node. Renders 150 frames of
// a plasma shader and writes PNGs for ffmpeg.
import { mkdirSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { init, effect, target } from "vgpu/node";

const W = 480;
const H = 270;
const FRAMES = 150;
const TAU = 6.283_185_307;

const SHADER = /* wgsl */ `
struct Params { time: f32, res: vec2f }
@group(0) @binding(0) var<uniform> params: Params;

fn palette(t: f32) -> vec3f {
  let a = vec3f(0.52, 0.50, 0.55);
  let b = vec3f(0.45, 0.42, 0.40);
  let c = vec3f(1.0, 1.1, 0.9);
  let d = vec3f(0.15, 0.35, 0.60);
  return a + b * cos(6.28318 * (c * t + d));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = (uv - 0.5) * vec2f(params.res.x / params.res.y, 1.0) * 2.0;
  var acc = 0.0;
  var amp = 0.5;
  var scale = 1.0;
  for (var i = 0; i < 5; i++) {
    let drift = vec2f(sin(params.time * 0.3 + scale), cos(params.time * 0.2)) * 0.6;
    let q = p * scale + drift;
    acc += amp * sin(length(q) * 3.0 - params.time * 1.2 + sin(q.x * 2.0 + params.time) * 0.8);
    amp *= 0.55;
    scale *= 1.7;
  }
  let v = acc * 0.5 + 0.5;
  let col = palette(v + params.time * 0.05);
  let vign = smoothstep(1.6, 0.3, length(p));
  return vec4f(col * vign, 1.0);
}
`;

mkdirSync("frames", { recursive: true });

const gpu = await init();
const colorTarget = target(gpu, { size: [W, H] });
const plasma = effect(gpu, SHADER, { set: { params: { time: 0, res: [W, H] } } });

for (let i = 0; i < FRAMES; i++) {
  plasma.set({ params: { time: (i / FRAMES) * TAU } });
  plasma.draw(colorTarget);
  const pixels = await colorTarget.read();
  const png = new PNG({ width: W, height: H });
  png.data.set(pixels);
  writeFileSync(`frames/f-${String(i).padStart(4, "0")}.png`, PNG.sync.write(png));
  if (i === 0) console.log("first frame pixels ok:", pixels.length, "bytes, px0 =", pixels.subarray(0, 4).join(","));
}

gpu.dispose(); // stops Dawn's polling so the process exits
console.log(`rendered ${FRAMES} frames @ ${W}x${H} (headless Metal via vgpu/node)`);
