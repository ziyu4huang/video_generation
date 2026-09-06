// Solar system — runtime-agnostic vgpu scene (browser AND vgpu/node).
// Same `createSolarScene` drives the React tab and the headless pixel check:
// meshes: one unit sphere instanced 9× (sun + planets, uniforms drive orbit),
// 700 hash-seeded asteroid-belt instances, a ring geometry for Saturn,
// thin torus orbit lines, and a post effect (starfield + sun glow + vignette).
import {
  draw,
  effect,
  frame,
  geometry,
  sampler,
  target,
} from "vgpu";
import { ring, sphere, torus } from "vgpu/scene";

// ── mat4 helpers (column-major Float32Array[16], WebGPU z ∈ [0,1]) ──────────
function matMul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = far / (near - far); m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}
function lookAt(eye, center, up) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const nrm = (a) => { const l = Math.hypot(...a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const z = nrm(sub(eye, center));           // camera backward
  const x = nrm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}
function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
}
function scaleM(s) {
  return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]);
}
function translateM(x, y, z) {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
}

// ── scene constants ─────────────────────────────────────────────────────────
const PLANET_COUNT = 9;
const BELT_COUNT = 700;
const RING_INNER = 0.95;
const RING_OUTER = 1.58;
const SATURN_INDEX = 6;
// [orbitRadius, angularSpeed(rad/s), phase, size, tilt, polarFactor, feature, bandFreq]
const PLANETS = [
  { orbit: 0,    speed: 0,     phase: 0,   size: 1.5,  tilt: 0,    polar: 0, feature: 0, band: 0,   a: [1.0, 0.55, 0.1], b: [1.0, 0.85, 0.3] }, // sun (emissive)
  { orbit: 3.2,  speed: 0.53,  phase: 0.0, size: 0.14, tilt: 0.03, polar: 0, feature: 0, band: 0,   a: [0.62, 0.56, 0.5], b: [0.45, 0.4, 0.36] },
  { orbit: 4.4,  speed: 0.39,  phase: 1.3, size: 0.3,  tilt: 0.05, polar: 0, feature: 0, band: 6,   a: [0.86, 0.7, 0.42], b: [0.93, 0.82, 0.6] },
  { orbit: 5.8,  speed: 0.3,   phase: 2.1, size: 0.32, tilt: 0.41, polar: 1, feature: 1, band: 0,   a: [0.23, 0.47, 0.85], b: [0.2, 0.62, 0.35] }, // earth
  { orbit: 7.3,  speed: 0.24,  phase: 4.2, size: 0.2,  tilt: 0.44, polar: 0.8, feature: 0, band: 0, a: [0.78, 0.35, 0.18], b: [0.65, 0.42, 0.3] },
  { orbit: 11.2, speed: 0.13,  phase: 0.7, size: 0.85, tilt: 0.05, polar: 0, feature: 0, band: 14,  a: [0.82, 0.7, 0.55], b: [0.62, 0.48, 0.36] }, // jupiter
  { orbit: 14.2, speed: 0.1,   phase: 3.4, size: 0.72, tilt: 0.47, polar: 0, feature: 0, band: 10,  a: [0.87, 0.76, 0.52], b: [0.72, 0.62, 0.44] }, // saturn
  { orbit: 16.6, speed: 0.08,  phase: 5.1, size: 0.46, tilt: 1.7,  polar: 0, feature: 0, band: 4,   a: [0.62, 0.85, 0.88], b: [0.5, 0.75, 0.8] },
  { orbit: 18.8, speed: 0.065, phase: 1.9, size: 0.44, tilt: 0.49, polar: 0, feature: 0, band: 6,   a: [0.22, 0.36, 0.85], b: [0.15, 0.28, 0.7] },
];
const SUN = PLANETS[0];

const BODY_SHADER = /* wgsl */ `
struct Cam { viewProjection: mat4x4f, camPos: vec4f }
@group(0) @binding(0) var<uniform> cam: Cam;
struct Tm { time: f32, mode: f32, pad: vec2f }
@group(0) @binding(1) var<uniform> tm: Tm;
@group(0) @binding(2) var<uniform> pdata: array<vec4f, 16>;   // orbitRadius, speed, phase, size
@group(0) @binding(3) var<uniform> cdata: array<vec4f, 48>;   // colorA[i], colorB[i+16], extra[i+32]

fn hash11(n: f32) -> f32 { return fract(sin(n) * 43758.5453123); }
fn hash31(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453123); }
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3f(1,0,0)), u.x), mix(hash31(i + vec3f(0,1,0)), hash31(i + vec3f(1,1,0)), u.x), u.y),
    mix(mix(hash31(i + vec3f(0,0,1)), hash31(i + vec3f(1,0,1)), u.x), mix(hash31(i + vec3f(0,1,1)), hash31(i + vec3f(1,1,1)), u.x), u.y),
    u.z);
}
fn rotZ(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) worldN: vec3f,
  @location(1) localN: vec3f,
  @location(2) worldPos: vec3f,
  @location(3) colA: vec4f,
  @location(4) colB: vec4f,
  @location(5) extra: vec4f,
}

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f,
                   @builtin(instance_index) idx: u32) -> VOut {
  var orbitR: f32; var speed: f32; var phase: f32; var size: f32;
  var cA: vec4f; var cB: vec4f; var ex: vec4f;
  if (tm.mode < 0.5) {
    orbitR = pdata[idx].x; speed = pdata[idx].y; phase = pdata[idx].z; size = pdata[idx].w;
    cA = cdata[idx]; cB = cdata[idx + 16]; ex = cdata[idx + 32];
  } else {
    let i = f32(idx);
    orbitR = 8.6 + (hash11(i * 1.73) - 0.5) * 2.4;
    speed = 0.2 + hash11(i * 2.89) * 0.14;
    phase = hash11(i * 3.77) * 6.2832;
    size = 0.018 + hash11(i * 4.51) * 0.05;
    let g = 0.42 + hash11(i * 6.7) * 0.25;
    cA = vec4f(g, g * 0.92, g * 0.84, 0.0);
    cB = cA;
    ex = vec4f((hash11(i * 7.3) - 0.5) * 1.2, 0.0, 0.0, 0.0);
  }
  let ang = speed * tm.time + phase;
  let center = vec3f(cos(ang) * orbitR, 0.0, sin(ang) * orbitR);
  let local = rotZ(position, ex.x);
  var out: VOut;
  out.worldPos = center + local * size;
  out.position = cam.viewProjection * vec4f(out.worldPos, 1.0);
  out.worldN = rotZ(normal, ex.x);
  out.localN = normalize(position);
  out.colA = cA; out.colB = cB; out.extra = ex;
  return out;
}

fn fbm3(p: vec3f) -> f32 {
  var v = 0.0; var amp = 0.5; var q = p;
  for (var i = 0; i < 4; i++) { v += amp * vnoise(q); amp *= 0.5; q = q * 2.03 + vec3f(11.3); }
  return v;
}

@fragment fn fs_main(in: VOut) -> @location(0) vec4f {
  let N = normalize(in.worldN);
  let V = normalize(cam.camPos.xyz - in.worldPos);
  let L = normalize(-in.worldPos); // sun sits at the origin

  if (in.colA.a > 0.5) { // the sun — animated emissive plasma
    let n = fbm3(in.localN * 2.5 + vec3f(tm.time * 0.04, tm.time * 0.02, 0.0));
    let heat = pow(0.5 + 0.5 * n, 1.5);
    var col = mix(vec3f(0.95, 0.25, 0.02), vec3f(1.0, 0.85, 0.35), heat);
    col += vec3f(1.0, 0.6, 0.2) * fbm3(in.localN * 6.0 - vec3f(0.0, tm.time * 0.06, 0.0)) * 0.3;
    let fr = pow(1.0 - max(dot(N, V), 0.0), 2.0);
    col += vec3f(1.0, 0.5, 0.1) * fr * 0.9;
    return vec4f(col, 1.0);
  }

  var alb = in.colA.rgb;
  if (in.extra.w > 0.5) { // latitude bands (gas giants)
    let bn = fbm3(in.localN * 3.0 + vec3f(4.1)) * 1.8;
    alb = mix(alb, in.colB.rgb, 0.5 + 0.5 * sin(in.localN.y * in.extra.w + bn));
  }
  if (in.extra.z > 0.5) { // continents (earth)
    let land = smoothstep(0.47, 0.54, fbm3(in.localN * 3.1 + vec3f(7.0)));
    alb = mix(alb, in.colB.rgb, land);
  }
  let polar = smoothstep(0.7, 0.92, abs(in.localN.y)) * in.extra.y;
  alb = mix(alb, vec3f(0.93, 0.95, 0.97), polar);

  let diff = max(dot(N, L), 0.0);
  var col = alb * (0.02 + diff * 1.3);
  let fr = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3f(0.35, 0.55, 1.0) * fr * 0.3 * in.extra.z * max(diff, 0.12); // atmosphere
  return vec4f(col, 1.0);
}
`;

const ORBIT_SHADER = /* wgsl */ `
struct Cam { viewProjection: mat4x4f, camPos: vec4f }
@group(0) @binding(0) var<uniform> cam: Cam;
struct Obj { model: mat4x4f, color: vec4f }
@group(0) @binding(1) var<uniform> obj: Obj;
struct VOut { @builtin(position) position: vec4f, @location(0) color: vec4f }
@vertex fn vs_main(@location(0) position: vec3f) -> VOut {
  var out: VOut;
  out.position = cam.viewProjection * obj.model * vec4f(position, 1.0);
  out.color = obj.color;
  return out;
}
@fragment fn fs_main(@location(0) color: vec4f) -> @location(0) vec4f {
  return vec4f(color.rgb, 1.0);
}
`;

const RING_SHADER = /* wgsl */ `
struct Cam { viewProjection: mat4x4f, camPos: vec4f }
@group(0) @binding(0) var<uniform> cam: Cam;
struct Obj { model: mat4x4f }
@group(0) @binding(1) var<uniform> obj: Obj;
struct VOut { @builtin(position) position: vec4f, @location(0) local: vec3f }
@vertex fn vs_main(@location(0) position: vec3f) -> VOut {
  var out: VOut;
  out.local = position;
  out.position = cam.viewProjection * obj.model * vec4f(position, 1.0);
  return out;
}
@fragment fn fs_main(@location(0) local: vec3f) -> @location(0) vec4f {
  let t = clamp((length(local.xy) - ${RING_INNER}) / (${RING_OUTER - RING_INNER}), 0.0, 1.0);
  var a = 0.55 + 0.45 * sin(t * 46.0);
  a *= 1.0 - 0.9 * smoothstep(0.52, 0.57, t) * (1.0 - smoothstep(0.6, 0.66, t)); // Cassini gap
  let col = mix(vec3f(0.82, 0.72, 0.54), vec3f(0.58, 0.5, 0.4), t);
  return vec4f(col, clamp(a, 0.0, 1.0) * 0.9);
}
`;

const POST_SHADER = /* wgsl */ `
struct Post { sun: vec4f, time: f32, aspect: f32, pad: vec2f }
@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123); }
fn starLayer(uv: vec2f, scale: f32, t: f32, thresh: f32) -> f32 {
  let g = uv * scale;
  let cell = floor(g);
  let h = hash21(cell);
  if (h < thresh) { return 0.0; }
  let sp = vec2f(hash21(cell + 3.7), hash21(cell + 7.3)) * 0.6 + 0.2;
  let d = length(fract(g) - sp);
  let tw = 0.72 + 0.28 * sin(t * 2.2 + h * 43.0);
  return smoothstep(0.12, 0.0, d) * tw * (0.35 + h);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = vec2f(uv.x * post.aspect, uv.y);
  var stars = starLayer(p, 42.0, post.time, 0.93) * 0.9;
  stars += starLayer(p, 90.0, post.time, 0.955) * 0.55;
  let band = exp(-pow((uv.y - 0.5 + 0.35 * (uv.x - 0.5)) * 3.4, 2.0));
  stars += band * (0.028 + 0.02 * hash21(floor(uv * 220.0)));
  let s = textureSampleLevel(src, samp, uv, 0.0);
  var col = stars * (1.0 - s.a) + s.rgb;
  if (post.sun.w > 0.0) { // screen-space sun glow (sun projected on the CPU)
    let d = length((uv - post.sun.xy) * vec2f(post.aspect, 1.0));
    col += vec3f(1.0, 0.72, 0.38) * (exp(-d * 13.0) * 0.5 + exp(-d * 3.2) * 0.09) * post.sun.w;
  }
  col *= 1.0 - 0.32 * smoothstep(0.42, 0.85, length(uv - vec2f(0.5, 0.5)));
  return vec4f(col, 1.0);
}
`;

export async function createSolarScene(gpu) {
  const unitSphere = geometry(gpu, sphere({ radius: 1, widthSegments: 48, heightSegments: 24 }));
  const beltSphere = geometry(gpu, sphere({ radius: 1, widthSegments: 8, heightSegments: 5 }));
  const orbitTorus = geometry(gpu, torus({ radius: 1, tube: 0.0022, radialSegments: 5, tubularSegments: 160 }));
  const saturnRing = geometry(gpu, ring({ innerRadius: RING_INNER, outerRadius: RING_OUTER, segments: 128 }));

  const planetDraw = draw(gpu, { shader: BODY_SHADER, geometry: unitSphere, instances: PLANET_COUNT, cull: "back" });
  const beltDraw = draw(gpu, { shader: BODY_SHADER, geometry: beltSphere, instances: BELT_COUNT, cull: "back" });
  const ringDraw = draw(gpu, { shader: RING_SHADER, geometry: saturnRing, blend: "alpha", depth: { write: false, compare: "less-equal" } });
  const orbitDraw = draw(gpu, { shader: ORBIT_SHADER, geometry: orbitTorus });
  const postEffect = effect(gpu, POST_SHADER);
  const postSampler = sampler(gpu, { minFilter: "linear", magFilter: "linear" });

  const pdata = PLANETS.map((p) => [p.orbit, p.speed, p.phase, p.size]);
  const cdata = [
    ...PLANETS.map((p) => [p.a[0], p.a[1], p.a[2], p === SUN ? 1 : 0]), // a.w = emissive flag
    ...PLANETS.map((p) => [p.b[0], p.b[1], p.b[2], 0]),
    ...PLANETS.map((p) => [p.tilt, p.polar, p.feature, p.band]),
  ];

  let sceneTarget;
  let aspect = 16 / 9;

  function resize(w, h) {
    aspect = w / h;
    sceneTarget?.dispose?.();
    sceneTarget = target(gpu, { size: [w, h], depth: true });
    postEffect.set({ src: sceneTarget, samp: postSampler });
  }

  function cameraFrom(yaw, pitch, dist) {
    const eye = [
      dist * Math.cos(pitch) * Math.sin(yaw),
      dist * Math.sin(pitch),
      dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const proj = perspective(50 * (Math.PI / 180), aspect, 0.1, 400);
    return {
      vp: matMul(proj, view),
      eye,
      // project the sun (origin) to the screen for the glow: clip = M · (0,0,0,1)
      sun: (() => {
        const m = matMul(proj, view);
        const cw = m[15];
        if (cw <= 0.0001) return [0, 0, 0];
        return [m[3] / cw * 0.5 + 0.5, 0.5 - m[7] / cw * 0.5, 1];
      })(),
    };
  }

  function render(timeSec, camState, canvasTarget) {
    const cam = cameraFrom(camState.yaw, camState.pitch, camState.dist);
    const saturn = PLANETS[SATURN_INDEX];
    const sa = saturn.speed * timeSec + saturn.phase;
    const satPos = [Math.cos(sa) * saturn.orbit, 0, Math.sin(sa) * saturn.orbit];
    const ringModel = matMul(translateM(...satPos), rotX(-Math.PI / 2 + saturn.tilt));

    frame(gpu, (f) => {
      f.pass({ target: sceneTarget, clear: [0, 0, 0, 0] }, (pass) => {
        for (const p of PLANETS) {
          if (p.orbit === 0) continue;
          orbitDraw.set({
            cam: { viewProjection: cam.vp, camPos: [...cam.eye, 0] },
            obj: { model: matMul(rotX(-Math.PI / 2), scaleM(p.orbit)), color: [0.4, 0.46, 0.56, 1] },
          });
          pass.draw(orbitDraw);
        }
        planetDraw.set({
          cam: { viewProjection: cam.vp, camPos: [...cam.eye, 0] },
          tm: { time: timeSec, mode: 0, pad: [0, 0] },
          pdata,
          cdata,
        });
        pass.draw(planetDraw);
        beltDraw.set({
          cam: { viewProjection: cam.vp, camPos: [...cam.eye, 0] },
          tm: { time: timeSec, mode: 1, pad: [0, 0] },
          pdata,
          cdata,
        });
        pass.draw(beltDraw);
        ringDraw.set({
          cam: { viewProjection: cam.vp, camPos: [...cam.eye, 0] },
          obj: { model: ringModel },
        });
        pass.draw(ringDraw);
      });
      f.pass({ target: canvasTarget, clear: [0.004, 0.004, 0.012, 1] }, (pass) => {
        postEffect.set({
          post: { sun: [...cam.sun, cam.sun[2]], time: timeSec, aspect, pad: [0, 0] },
        });
        pass.draw(postEffect);
      });
    });
  }

  return {
    resize,
    render,
    dispose() {
      sceneTarget?.dispose?.();
      for (const d of [planetDraw, beltDraw, ringDraw, orbitDraw, postEffect]) d.dispose?.();
      gpu.dispose();
    },
  };
}
