// MacBook teardown (拆解) — runtime-agnostic vgpu scene, same pattern as the
// solar/palace scenes: `createMacbookScene(gpu)` drives the React tab and the
// headless pixel check.
//
// An exploded-view laptop: assembled it's an open space-grey MacBook (live
// wallpaper screen with menu bar / dock / notch, backlit keyboard, trackpad,
// glowing logo); an explode factor (0..1, slider or auto) slides the assembly
// apart into a teardown stack with per-group stagger — bottom shell → battery
// → logic board + spinning fans + heat pipe → keyboard deck → display lid
// (which flattens from open to flat as it lifts).
//
// Every part is one instance in a storage buffer (20 floats: pos+rotY,
// scale+rotX, color+mode, explode-offset+group, local-offset+spin).
// Groups: 0 bottom shell · 1 battery · 2 internals (board/fans/ports/
// speakers) · 3 top case + keys + trackpad · 4 lid · 9 floor.
import {
  draw,
  effect,
  frame,
  geometry,
  sampler,
  storage,
  target,
} from "vgpu";
import { box, cylinder } from "vgpu/scene";

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
  const z = nrm(sub(eye, center));
  const x = nrm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

// ── palette (space grey on a light studio set) ───────────────────────────────
const C = {
  alu:      [0.235, 0.24, 0.26],  // anodized space-grey aluminum
  aluDark:  [0.17, 0.175, 0.19],  // fan frames, feet, well trim
  keycap:   [0.12, 0.12, 0.13],
  pcb:      [0.04, 0.19, 0.09],
  chip:     [0.08, 0.08, 0.09],
  chipTop:  [0.5, 0.51, 0.53],
  cell:     [0.27, 0.275, 0.29],
  copper:   [0.72, 0.42, 0.22],
  blade:    [0.34, 0.35, 0.38],
  port:     [0.05, 0.05, 0.06],
  speaker:  [0.09, 0.09, 0.1],
  trackpad: [0.29, 0.295, 0.315],
  floor:    [0.88, 0.885, 0.905],
};
// material modes: 0 alu body · 1 keycap (backlit) · 2 pcb · 3 chip ·
// 4 battery cell · 5 copper · 6 dark plastic · 7 fan blade · 8 (spare) ·
// 9 lid: screen / alu / logo · 10 studio floor · 11 port · 12 speaker ·
// 13 trackpad
const G_SHELL = 0, G_BATT = 1, G_INTERN = 2, G_TOP = 3, G_LID = 4;

// ── part tables ──────────────────────────────────────────────────────────────
// 20 floats/instance: pos.xyz+rotY · scale.xyz+rotX · rgb+mode ·
// explodeOffset.xyz+group · localOffset.xyz+spin
const parts = [];
function part(o) {
  const p = {
    x: 0, y: 0, z: 0, rotY: 0, sx: 1, sy: 1, sz: 1, rotX: 0,
    c: [1, 0, 1], mode: 0, ex: [0, 0, 0], g: 0, off: [0, 0, 0], spin: 0,
    ...o,
  };
  parts.push(p);
  return p;
}
const B = (o) => { const p = part(o); p.kind = "box"; return p; };
const CYL = (o) => { const p = part(o); p.kind = "cyl"; return p; };

function buildLayout() {
  const BASE_W = 12, BASE_D = 8.4;

  // ── studio floor (stays put; carries the fake contact shadow) ──
  B({ x: 0, y: -0.06, z: 0, sx: 70, sy: 0.12, sz: 70, c: C.floor, mode: 10, g: 9 });

  // ── bottom shell + feet (group 0) ──
  B({ x: 0, y: 0.26, z: 0, sx: BASE_W, sy: 0.42, sz: BASE_D, c: C.alu, mode: 0, g: G_SHELL, ex: [0, 0.12, 0] });
  for (const [fx, fz] of [[-5.2, -3.5], [5.2, -3.5], [-5.2, 3.5], [5.2, 3.5]])
    CYL({ x: fx, y: 0.05, z: fz, sx: 0.4, sy: 0.1, sz: 0.4, c: C.aluDark, mode: 6, g: G_SHELL, ex: [0, 0.12, 0] });

  // ── battery (group 1) ──
  for (let i = 0; i < 3; i++)
    B({ x: -2.6 + i * 2.6, y: 0.3, z: -0.9, sx: 2.35, sy: 0.22, sz: 5.6, c: C.cell, mode: 4, g: G_BATT, ex: [0, 1.55, 0] });

  // ── internals (group 2): logic board, chips, fans, heat pipe, ports, speakers ──
  B({ x: 2.9, y: 0.32, z: -0.6, sx: 5.4, sy: 0.12, sz: 6.6, c: C.pcb, mode: 2, g: G_INTERN, ex: [0, 2.85, 0] });
  B({ x: 2.4, y: 0.44, z: -1.2, sx: 1.7, sy: 0.13, sz: 1.7, c: C.chipTop, mode: 3, g: G_INTERN, ex: [0, 2.85, 0] });  // SoC
  for (const [cx, cz] of [[1.2, -2.6], [1.2, -1.2], [4.4, 0.4], [4.4, 1.8], [1.4, 0.6], [2.0, 1.9]])
    B({ x: cx, y: 0.43, z: cz, sx: 0.85, sy: 0.1, sz: 0.85, c: C.chip, mode: 3, g: G_INTERN, ex: [0, 2.85, 0] });      // RAM/SSD
  B({ x: 0.2, y: 0.42, z: -1.2, sx: 3.6, sy: 0.08, sz: 0.5, c: C.copper, mode: 5, g: G_INTERN, ex: [0, 2.85, 0] });   // heat pipe
  for (const sx of [-1, 1]) {
    // fan: square frame + dark cavity + spinning blades + hub
    const fx = 4.0 * sx, fz = 2.15;
    B({ x: fx, y: 0.3, z: fz, sx: 2.75, sy: 0.26, sz: 2.75, c: C.aluDark, mode: 6, g: G_INTERN, ex: [0, 2.85, sx * 1.6] });
    CYL({ x: fx, y: 0.3, z: fz, sx: 2.5, sy: 0.28, sz: 2.5, c: [0.04, 0.04, 0.05], mode: 6, g: G_INTERN, ex: [0, 2.85, sx * 1.6] });
    for (let b = 0; b < 9; b++)
      B({
        x: fx, y: 0.33, z: fz, sx: 0.14, sy: 0.05, sz: 1.0, rotY: (b * 2 * Math.PI) / 9,
        // flat blades (a blade pitch would need rotate-then-offset, which the
        // lid's hinge order forbids) — alternating tones read as a turbine
        c: b % 2 ? [0.44, 0.45, 0.48] : [0.24, 0.245, 0.26], mode: 7,
        g: G_INTERN, ex: [0, 2.85, sx * 1.6], off: [0, 0, 0.85], spin: 1,
      });
    CYL({ x: fx, y: 0.34, z: fz, sx: 0.62, sy: 0.24, sz: 0.62, c: C.aluDark, mode: 6, g: G_INTERN, ex: [0, 2.85, sx * 1.6], spin: 1 });
    // speaker
    B({ x: 5.55 * sx, y: 0.28, z: -1.6, sx: 0.5, sy: 0.24, sz: 4.6, c: C.speaker, mode: 12, g: G_INTERN, ex: [0, 2.85, 0] });
    // side ports
    for (const [pz, pw] of [[-0.6, 0.62], [0.4, 0.62], [1.35, 0.4]])
      B({ x: 5.97 * sx, y: 0.26, z: pz, sx: 0.14, sy: 0.14, sz: pw, c: C.port, mode: 11, g: G_INTERN, ex: [sx * 0.9, 2.85, 0] });
  }

  // ── top case (group 3): deck + keyboard well + keys + trackpad ──
  B({ x: 0, y: 0.57, z: 0, sx: BASE_W, sy: 0.18, sz: BASE_D, c: C.alu, mode: 0, g: G_TOP, ex: [0, 4.3, 0] });
  B({ x: 0, y: 0.67, z: -1.15, sx: 11.1, sy: 0.04, sz: 4.6, c: [0.05, 0.05, 0.055], mode: 6, g: G_TOP, ex: [0, 4.3, 0] });
  // keys: five staggered rows + bottom row with a wide spacebar
  const key = (x, z, w = 0.62) =>
    B({ x, y: 0.74, z, sx: w, sy: 0.12, sz: 0.62, c: C.keycap, mode: 1, g: G_TOP, ex: [0, 4.3, 0] });
  const rowZ = [-3.05, -2.28, -1.51, -0.74, 0.03];
  rowZ.forEach((z, r) => {
    const n = r < 4 ? 14 : 13;
    const x0 = -((n - 1) * 0.75) / 2 - (r === 4 ? 0.2 : 0);
    for (let i = 0; i < n; i++) key(x0 + i * 0.75, z);
  });
  key(-4.55, 0.8, 0.85); key(-3.6, 0.8, 0.8); key(-2.75, 0.8, 0.8); key(-1.8, 0.8, 1.15); // fn ctrl opt cmd
  key(0.35, 0.8, 3.5);                                                                     // space
  key(2.5, 0.8, 1.15); key(3.45, 0.8, 0.8);                                                // cmd opt
  key(4.55, 0.55); key(4.55, 1.05);                                                        // arrows
  B({ x: 0, y: 0.675, z: 2.9, sx: 4.4, sy: 0.05, sz: 3.0, c: C.trackpad, mode: 13, g: G_TOP, ex: [0, 4.3, 0] });

  // ── display lid (group 4): hinged at the back, flattens as it lifts ──
  // rotX ≈ -1.82 stands the slab up from the hinge (local +z swings to +y,
  // tilted back ~15°); local -y face (the screen) then fronts the keyboard.
  B({
    x: 0, y: 0.7, z: -4.15, sx: BASE_W, sy: 0.34, sz: 8.0, rotX: -1.82,
    c: C.alu, mode: 9, g: G_LID, ex: [0, 5.0, -1.6], off: [0, 0, 4.0],
  });
}

function packInstances() {
  const pack = (kind) => {
    const list = parts.filter((p) => p.kind === kind);
    const f = new Float32Array(Math.max(1, list.length) * 20);
    list.forEach((p, i) => {
      f.set([
        p.x, p.y, p.z, p.rotY,
        p.sx, p.sy, p.sz, p.rotX,
        p.c[0], p.c[1], p.c[2], p.mode,
        p.ex[0], p.ex[1], p.ex[2], p.g,
        p.off[0], p.off[1], p.off[2], p.spin,
      ], i * 20);
    });
    return { data: f, count: list.length };
  };
  return { box: pack("box"), cyl: pack("cyl") };
}

// ── shaders ──────────────────────────────────────────────────────────────────
const BODY_SHADER = /* wgsl */ `
struct Cam { viewProjection: mat4x4f, camPos: vec4f }
@group(0) @binding(0) var<uniform> cam: Cam;
struct Tm { time: f32, explode: f32, pad: vec2f }
@group(0) @binding(1) var<uniform> tm: Tm;
struct Inst {
  posRot: vec4f,    // xyz pos · w rotY
  sclRot: vec4f,    // xyz scale · w rotX (assembled pose; lid flattens on explode)
  colMode: vec4f,   // rgb · w mode
  exGroup: vec4f,   // xyz explode offset · w group
  offSpin: vec4f,   // xyz local offset (applied pre-rotation) · w spin flag
}
@group(0) @binding(2) var<storage, read> inst: array<Inst>;

const KEY = vec3f(1.0, 0.97, 0.93);    // warm key light
const FILL = vec3f(0.6, 0.7, 1.0);     // cool fill / rim

fn hash11(n: f32) -> f32 { return fract(sin(n) * 43758.5453123); }
fn hash31(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453123); }
fn vnoise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3f(1,0,0)), u.x), mix(hash31(i + vec3f(0,1,0)), hash31(i + vec3f(1,1,0)), u.x), u.y),
    mix(mix(hash31(i + vec3f(0,0,1)), hash31(i + vec3f(1,0,1)), u.x), mix(hash31(i + vec3f(0,1,1)), hash31(i + vec3f(1,1,1)), u.x), u.y),
    u.z);
}
fn rotY(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
fn rotXv(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) worldN: vec3f,
  @location(2) localN: vec3f,
  @location(3) localPos: vec3f,
  @location(4) col: vec4f,
  @location(5) group: f32,
}

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f,
                   @builtin(instance_index) idx: u32) -> VOut {
  let I = inst[idx];
  let g = u32(I.exGroup.w);
  // staggered explode: later groups start moving later, all ease out
  let delay = f32(g) * 0.07;
  let k = smoothstep(delay, delay + 0.72, tm.explode);
  var rx = I.sclRot.w;
  if (g == ${G_LID}u) { rx = rx * (1.0 - k); }   // lid flattens while lifting
  let spin = I.offSpin.w * tm.time * 7.0;
  let lp = position * I.sclRot.xyz + I.offSpin.xyz;
  let world = I.posRot.xyz + rotY(rotXv(lp, rx), I.posRot.w + spin) + I.exGroup.xyz * k;
  var out: VOut;
  out.worldPos = world;
  out.worldN = rotY(rotXv(normal / max(I.sclRot.xyz, vec3f(1e-4)), rx), I.posRot.w + spin);
  out.localN = normal;
  out.localPos = position;
  out.col = I.colMode;
  out.group = I.exGroup.w;
  out.position = cam.viewProjection * vec4f(world, 1.0);
  return out;
}

@fragment fn fs_main(in: VOut) -> @location(0) vec4f {
  let N = normalize(in.worldN);
  let V = normalize(cam.camPos.xyz - in.worldPos);
  let L1 = normalize(vec3f(0.45, 0.8, 0.32));
  let L2 = normalize(vec3f(-0.55, 0.3, -0.7));
  let mode = in.col.a;
  var alb = in.col.rgb;
  var specStr = 0.06;
  var specPow = 32.0;
  var metal = 0.0;      // fresnel environment reflection weight
  var emis = vec3f(0.0);

  // crease shading: darken slightly toward every box edge (fake bevel AO)
  let ex2 = abs(in.localPos.x) * 2.0;
  let ey2 = abs(in.localPos.y) * 2.0;
  let ez2 = abs(in.localPos.z) * 2.0;
  let edge = smoothstep(0.8, 0.97, max(ex2, max(ey2, ez2)));
  alb *= 1.0 - edge * 0.16;

  if (mode < 0.5) {                                   // anodized aluminum
    alb *= 0.93 + 0.07 * vnoise3(in.worldPos * vec3f(1.5, 40.0, 1.5));   // brushed
    specStr = 0.32; specPow = 70.0; metal = 0.4;
  } else if (mode < 1.5) {                            // keycap with backlight glyph
    let bevel = 1.0 - smoothstep(0.3, 0.47, max(ex2, ez2));
    alb *= 0.8 + 0.5 * bevel;
    if (in.localN.y > 0.5) {                          // top face: glowing glyph
      let kd = length(in.localPos.xz) * 2.2;
      emis = vec3f(0.65, 0.75, 1.0) * (1.0 - smoothstep(0.05, 0.5, kd)) * 0.4;
    }
    specStr = 0.1; specPow = 40.0;
  } else if (mode < 2.5) {                            // PCB: traces + gold edge
    let tr1 = smoothstep(0.93, 0.98, abs(fract(in.worldPos.x * 2.4) - 0.5) * 2.0);
    let tr2 = smoothstep(0.93, 0.98, abs(fract(in.worldPos.z * 3.1) - 0.5) * 2.0);
    alb = mix(alb, alb * 1.9 + vec3f(0.02, 0.1, 0.05), max(tr1, tr2) * 0.45);
    // gold pads along the board PLANE edges only, thin rim (a wide margin
    // gilds most of a flat board since |local|*2 crosses 0.4 at 20% inset)
    let pad = smoothstep(0.86, 0.94, max(ex2, ez2));
    alb = mix(alb, vec3f(0.72, 0.58, 0.25), pad * 0.85);
    specStr = 0.12; specPow = 45.0;
  } else if (mode < 3.5) {                            // chip plastic / heatspreader
    specStr = 0.24; specPow = 55.0;
  } else if (mode < 4.5) {                            // battery cell
    alb *= 0.95 + 0.05 * vnoise3(in.worldPos * 8.0);
    specStr = 0.18; specPow = 50.0;
  } else if (mode < 5.5) {                            // copper
    specStr = 0.55; specPow = 80.0; metal = 0.3;
  } else if (mode < 6.5) {                            // dark plastic (fans, well)
    specStr = 0.08; specPow = 30.0;
  } else if (mode < 7.5) {                            // fan blade
    alb *= 0.75 + 0.4 * vnoise3(in.worldPos * 25.0);
    specStr = 0.3; specPow = 60.0;
  } else if (mode < 9.5) {                            // lid: screen / alu / logo
    if (in.localN.y < -0.5) {                         // screen face: macOS-like
      let uv = in.localPos.xz + 0.5;
      let asp = 1.5;                                  // lid plan aspect (12 × 8)
      let bezel = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
      let t = tm.time;
      let w1 = 0.5 + 0.5 * sin(uv.x * 5.0 + t * 0.7 + sin(uv.y * 6.0 - t * 0.4));
      let w2 = 0.5 + 0.5 * sin(uv.y * 7.0 - t * 0.5 + uv.x * 3.0);
      var glow = mix(vec3f(0.07, 0.16, 0.62), vec3f(0.68, 0.2, 0.75), w1);
      glow = mix(glow, vec3f(1.0, 0.46, 0.5), w2 * w1 * 0.8) * 1.15;
      emis = glow * (1.0 - smoothstep(0.44, 0.47, bezel));
      // menu bar
      emis += vec3f(0.9, 0.92, 0.95) * smoothstep(0.925, 0.935, uv.y) * (1.0 - smoothstep(0.44, 0.47, bezel)) * 0.3;
      // dock: rainbow dots
      let px = (uv.x - 0.5) * asp;
      let dc = floor(px / 0.052);
      let dd = length(vec2(fract(px / 0.052) - 0.5, (uv.y - 0.06) / 0.032));
      let hue = vec3f(0.35 + 0.65 * hash11(dc), 0.4 + 0.5 * hash11(dc + 7.0), 0.55 + 0.45 * hash11(dc + 13.0));
      emis += hue * smoothstep(0.34, 0.22, dd) * step(abs(px), 0.4) * step(uv.y, 0.11) * 0.9;
      // notch cut into the top of the wallpaper
      let notch = (1.0 - smoothstep(0.055, 0.07, abs(uv.x - 0.5) * asp)) * smoothstep(0.86, 0.885, uv.y);
      emis *= 1.0 - notch;
      alb = vec3f(0.02);
    } else if (in.localN.y > 0.5) {                   // back cover + glowing logo
      let ell = length(in.localPos.xz * vec2f(2.6, 4.2));   // box center is local 0
      emis = vec3f(0.95) * smoothstep(0.075, 0.05, ell) * 1.1;
      alb *= 0.93 + 0.07 * vnoise3(in.worldPos * vec3f(1.5, 40.0, 1.5));
    }
    specStr = 0.3; specPow = 65.0; metal = 0.35;
  } else if (mode < 10.5) {                           // studio floor + contact shadow
    let d = length(in.worldPos.xz - vec2f(0.0, 0.3));
    alb *= 1.0 - 0.5 * smoothstep(7.5, 2.0, d) - 0.22 * smoothstep(15.0, 3.5, d);
    alb = mix(alb, vec3f(0.855, 0.862, 0.882), smoothstep(15.0, 33.0, d));
  } else if (mode < 11.5) {                           // port cutouts
    specStr = 0.3; specPow = 60.0;
  } else if (mode < 12.5) {                           // speaker grille
    let g = abs(fract(in.worldPos.xz * 6.0) - 0.5) * 2.0;
    alb *= 1.0 - 0.5 * smoothstep(0.55, 0.85, max(g.x, g.y));
  } else {                                            // trackpad glass
    specStr = 0.4; specPow = 95.0; metal = 0.2;
  }

  let diff1 = max(dot(N, L1), 0.0);
  let diff2 = max(dot(N, L2), 0.0);
  let sky = mix(vec3f(0.3, 0.3, 0.32), vec3f(0.66, 0.67, 0.7), N.y * 0.5 + 0.5);
  var col = alb * (sky * 0.5 + KEY * (0.22 + 0.88 * diff1) + FILL * 0.3 * diff2) + emis;
  if (specStr > 0.0) {
    let Hw = normalize(L1 + V);
    col += KEY * pow(max(dot(N, Hw), 0.0), specPow) * specStr;
  }
  if (metal > 0.0) {                                  // fake env reflection on metal
    let R = reflect(-V, N);
    let env = mix(vec3f(0.38, 0.39, 0.42), vec3f(0.95, 0.96, 0.99), R.y * 0.5 + 0.5);
    col += env * pow(1.0 - max(dot(N, V), 0.0), 4.0) * metal;
  }
  // cool rim from behind for edge separation
  let rim = pow(max(dot(N, L2), 0.0), 2.5) * (0.3 + 0.7 * pow(1.0 - max(dot(N, V), 0.0), 2.0));
  col += FILL * rim * 0.3;
  return vec4f(col, 1.0);
}
`;

const POST_SHADER = /* wgsl */ `
struct Post { pad0: vec4f, time: f32, aspect: f32, pad: vec2f }
@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let h = 1.0 - uv.y;   // uv.y is 0 at screen top
  // infinity-cove backdrop: soft grey, gently lighter toward the top
  var col = mix(vec3f(0.845, 0.852, 0.872), vec3f(0.97, 0.97, 0.975), smoothstep(0.02, 0.8, h));
  let s = textureSampleLevel(src, samp, uv, 0.0);
  col = col * (1.0 - s.a) + s.rgb;
  col *= 1.0 - 0.14 * smoothstep(0.5, 0.95, length(uv - vec2f(0.5, 0.52)));
  return vec4f(col, 1.0);
}
`;

// ── scene assembly ───────────────────────────────────────────────────────────
export async function createMacbookScene(gpu) {
  buildLayout();
  const inst = packInstances();

  const boxGeo = geometry(gpu, box({ size: 1 }));
  const cylGeo = geometry(gpu, cylinder({ radius: 0.5, height: 1 }));

  const mkBuf = (t) => storage(gpu, t.data.byteLength, "read");
  const boxBuf = mkBuf(inst.box);
  const cylBuf = mkBuf(inst.cyl);
  boxBuf.write(inst.box.data);
  cylBuf.write(inst.cyl.data);

  const shader = { shader: BODY_SHADER, cull: "back" };
  const boxDraw = draw(gpu, { ...shader, geometry: boxGeo, instances: inst.box.count });
  const cylDraw = draw(gpu, { ...shader, geometry: cylGeo, instances: inst.cyl.count });
  const postEffect = effect(gpu, POST_SHADER);
  const postSampler = sampler(gpu, { minFilter: "linear", magFilter: "linear" });

  let sceneTarget;
  let aspect = 16 / 9;

  function resize(w, h) {
    aspect = w / h;
    sceneTarget?.dispose?.();
    sceneTarget = target(gpu, { size: [w, h], depth: true });
    postEffect.set({ src: sceneTarget, samp: postSampler });
  }

  function cameraFrom(yaw, pitch, dist) {
    const tgt = [0, 2.2, 0];
    const eye = [
      tgt[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      tgt[1] + dist * Math.sin(pitch),
      tgt[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const view = lookAt(eye, tgt, [0, 1, 0]);
    const proj = perspective(42 * (Math.PI / 180), aspect, 0.1, 300);
    return { vp: matMul(proj, view), eye };
  }

  function render(timeSec, camState, explode, canvasTarget) {
    const cam = cameraFrom(camState.yaw, camState.pitch, camState.dist);
    frame(gpu, (f) => {
      f.pass({ target: sceneTarget, clear: [0, 0, 0, 0] }, (pass) => {
        const camU = { viewProjection: cam.vp, camPos: [...cam.eye, 0] };
        boxDraw.set({ cam: camU, tm: { time: timeSec, explode, pad: [0, 0] }, inst: boxBuf });
        pass.draw(boxDraw);
        cylDraw.set({ cam: camU, tm: { time: timeSec, explode, pad: [0, 0] }, inst: cylBuf });
        pass.draw(cylDraw);
      });
      f.pass({ target: canvasTarget, clear: [0.88, 0.885, 0.9, 1] }, (pass) => {
        postEffect.set({ post: { pad0: [0, 0, 0, 0], time: timeSec, aspect, pad: [0, 0] } });
        pass.draw(postEffect);
      });
    });
  }

  return {
    resize,
    render,
    stats: { boxes: inst.box.count, cyls: inst.cyl.count },
    dispose() {
      sceneTarget?.dispose?.();
      for (const d of [boxDraw, cylDraw, postEffect]) d.dispose?.();
      gpu.dispose();
    },
  };
}
