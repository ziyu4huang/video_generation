// Forbidden City (紫禁城) — runtime-agnostic vgpu scene, same pattern as the
// solar system: `createPalaceScene(gpu)` drives both the React tab and the
// headless pixel check.
//
// Everything static, one way: a south→north axial layout (午門 → 金水橋 →
// 太和門 → 太和殿 → 中和殿 → 保和殿 → 乾清宮 → 神武門) inside red perimeter
// walls with corner turrets (角樓), a moat (筒子河), and Jingshan (景山) with
// its pavilion north of the north gate.
//
// Geometry: axis-aligned boxes for architecture, custom parametric hip-roof
// meshes for the upturned-eave roofs (庑殿顶) and pyramidal roofs (攢尖顶),
// one squashed sphere for the hill. All parts live in ONE storage buffer
// (pos/rot, scale, color+material-mode per instance) — three draw calls
// (boxes / hip roofs / pyramids) share it via a per-draw base index.
import {
  draw,
  effect,
  frame,
  geometry,
  sampler,
  storage,
  target,
} from "vgpu";
import { box, sphere } from "vgpu/scene";

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

// ── palette ──────────────────────────────────────────────────────────────────
const C = {
  wall:   [0.52, 0.115, 0.075],  // 宮牆紅
  hall:   [0.55, 0.13, 0.09],   // 殿身紅 (shader adds columns + 彩畫 band)
  roof:   [0.88, 0.62, 0.17],   // 黃琉璃瓦
  marble: [0.86, 0.85, 0.80],   // 漢白玉
  gold:   [0.93, 0.72, 0.22],   // 金 (脊吻、門釘、日晷)
  water:  [0.09, 0.16, 0.17],   // 金水河/筒子河
  paving: [0.50, 0.48, 0.44],   // 磚鋪地面
  path:   [0.60, 0.58, 0.52],   // 中路御路
  leaf:   [0.13, 0.26, 0.10],   // 松柏
  trunk:  [0.23, 0.14, 0.09],
  hill:   [0.30, 0.38, 0.18],   // 景山
};

// sun direction (golden hour, south-west sky) — kept in sync with the glow
// the post pass projects on the CPU.
const SUN_DIR = (() => {
  const v = [-0.52, 0.40, 0.62];
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
})();
const SUN_DIR_WGSL = `vec3f(${SUN_DIR.map((x) => x.toFixed(4)).join(", ")})`;

// ── parametric Chinese roof ──────────────────────────────────────────────────
// Unit hip roof: footprint is the SQUARE x ∈ [-1,1] × z ∈ [-1,1] (scaled
// per-instance, so sx/sz are the roof's real plan dimensions), base y=0,
// apex ridge y=1 running x ∈ [-rf,rf]. The eave edge dips in the middle and
// flicks UP at the corners (飞檐翘角): zE pulls corners in, yE lifts them;
// the slope profile pow(t, hPow) makes it concave (shallow at the eave,
// steep at the ridge).
function hipRoofGeometry(gpu, { rf = 0.45, flare = 0.08, dip = 0.04, hPow = 1.35, segU = 22, segT = 9 }) {
  const lerp = (a, b, t) => a + (b - a) * t;
  const hz = 1;
  const zE = (u) => hz * (1 - flare * u * u);
  const yE = (u) => dip * u * u;
  // front/back sweep along x; side strips sweep along z and collapse to the
  // ridge end (fan) — corner (u=±1, t=0) matches the front strip's eave corner.
  const surf = (kind, u, t) => {
    const y = yE(u) * (1 - t) + Math.pow(t, hPow);
    if (kind === "front") return [u * lerp(1, rf, t), y, zE(u) * (1 - t)];
    if (kind === "back") return [u * lerp(1, rf, t), y, -zE(u) * (1 - t)];
    if (kind === "right") return [lerp(1, rf, t), y, u * hz * (1 - flare * u * u) * (1 - t)];
    return [-lerp(1, rf, t), y, u * hz * (1 - flare * u * u) * (1 - t)];
  };
  const refN = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0] };
  const pos = [], nrm = [], idx = [];
  let base = 0;
  for (const kind of ["front", "back", "right", "left"]) {
    for (let j = 0; j <= segT; j++) {
      for (let i = 0; i <= segU; i++) {
        const u = (i / segU) * 2 - 1;
        const t = j / segT;
        const e = 1e-3;
        const p = surf(kind, u, t);
        const uc = Math.max(-1, Math.min(1, u + e)), ucl = Math.max(-1, Math.min(1, u - e));
        const tc = Math.min(1, t + e), tcl = Math.max(0, t - e);
        const du = [0, 1, 2].map((k) => surf(kind, uc, t)[k] - surf(kind, ucl, t)[k]);
        const dt = [0, 1, 2].map((k) => surf(kind, u, tc)[k] - surf(kind, u, tcl)[k]);
        let n = [
          du[1] * dt[2] - du[2] * dt[1],
          du[2] * dt[0] - du[0] * dt[2],
          du[0] * dt[1] - du[1] * dt[0],
        ];
        if (n[0] * refN[kind][0] + n[1] * refN[kind][1] + n[2] * refN[kind][2] < 0)
          n = n.map((x) => -x);
        const l = Math.hypot(...n) || 1;
        pos.push(...p);
        nrm.push(n[0] / l, n[1] / l, n[2] / l);
      }
    }
    for (let j = 0; j < segT; j++)
      for (let i = 0; i < segU; i++) {
        const a = base + j * (segU + 1) + i;
        idx.push(a, a + 1, a + segU + 1, a + 1, a + segU + 2, a + segU + 1);
      }
    base += (segU + 1) * (segT + 1);
  }
  return geometry(gpu, {
    buffers: [{
      stride: 24,
      attributes: { position: "float32x3", normal: "float32x3" },
      data: new Float32Array([...pos, ...nrm]),
    }],
    vertexCount: pos.length / 3,
    indices: new Uint32Array(idx),
  });
}

// ── part tables ──────────────────────────────────────────────────────────────
// mode: 0 matte · 1 glazed roof · 2 marble · 3 gold · 4 door · 5 hall body
//       6 water · 7 foliage · 8 paving · 9 hill
const parts = [];
const B = (x, y, z, sx, sy, sz, c, mode = 0) => {
  const p = { x, y, z, sx, sy, sz, c, mode, kind: "box" };
  parts.push(p);
  return p;
};
const H = (x, y, z, sx, sy, sz, c = C.roof) => {
  const p = B(x, y, z, sx, sy, sz, c, 1);
  p.kind = "hip";
  return p;
};
const P = (x, y, z, sx, sy, sz, c = C.roof) => {
  const p = B(x, y, z, sx, sy, sz, c, 1);
  p.kind = "pyr";
  return p;
};
const HILL = (x, y, z, sx, sy, sz, c) => {
  const p = B(x, y, z, sx, sy, sz, c, 9);
  p.kind = "hill";
  return p;
};

function buildLayout() {
  // ── ground & axis ──
  B(0, -0.5, 0, 220, 1, 240, C.paving, 8);                       // ground slab
  B(0, 0.02, 12, 46, 0.1, 22, [0.45, 0.43, 0.39], 8);            // 太和殿廣場
  B(0, 0.045, 9, 6.5, 0.1, 62, C.path, 8);                       // 中路御路
  B(0, 0.045, -34, 6.5, 0.1, 20, C.path, 8);                     // 內廷御路

  // ── 午門 (Meridian Gate, 凹-shaped 城台) @ z≈+50 ──
  B(0, 3, 50, 30, 6, 8, C.wall);                                 // main 城台
  B(-16.5, 2.5, 46, 9, 5, 14, C.wall);                           // west wing
  B(16.5, 2.5, 46, 9, 5, 14, C.wall);                            // east wing
  B(0, 1.6, 54.1, 3.6, 3.2, 0.6, [0.08, 0.02, 0.02], 4);         // center arch
  B(-7, 1.3, 54.1, 2.6, 2.6, 0.6, [0.08, 0.02, 0.02], 4);        // side arches
  B(7, 1.3, 54.1, 2.6, 2.6, 0.6, [0.08, 0.02, 0.02], 4);
  B(0, 1.5, 45.9, 3.6, 3.0, 0.6, [0.08, 0.02, 0.02], 4);         // north arch
  B(0, 7.3, 50, 12, 2.6, 5.5, C.hall, 5);                        // 城樓 body
  H(0, 8.6, 50, 14, 2.1, 7);                                     // lower eave
  B(0, 9.7, 50, 8.5, 1.8, 4.5, C.hall, 5);                       // upper body
  H(0, 10.6, 50, 10, 2.9, 5.2);                                  // upper roof
  B(0, 13.5, 50, 5.4, 0.5, 0.8, C.gold, 3);                      // 正脊
  B(-2.9, 13.75, 50, 0.9, 1.3, 1.0, C.gold, 3);                  // 鴟吻
  B(2.9, 13.75, 50, 0.9, 1.3, 1.0, C.gold, 3);
  for (const sx of [-1, 1]) {                                    // wing pavilions + galleries
    B(16.5 * sx, 6.2, 46, 5, 2.4, 5, C.hall, 5);
    P(16.5 * sx, 7.4, 46, 6, 2.4, 6);
    B(16.5 * sx, 8.6, 46, 0.4, 1.2, 0.4, C.gold, 3);
    B(9.6 * sx, 6.6, 48, 8.4, 1.2, 2.4, C.hall, 5);
    H(9.6 * sx, 7.2, 48, 9.4, 1.1, 3.2);
  }

  // ── 金水河 + 五橋 @ z≈+40 ──
  B(0, -0.31, 40.5, 76, 0.7, 5.4, C.water, 6);
  for (const x of [-13, -6.5, 0, 6.5, 13]) {                     // stepped marble arches
    B(x, 0.3, 40.5, 3.4, 0.7, 6.6, C.marble, 2);
    B(x, 0.85, 40.5, 2.9, 0.5, 5.2, C.marble, 2);
    B(x, 1.35, 40.5, 2.4, 0.6, 3.8, C.marble, 2);
  }

  // ── 太和門 @ z≈+30 ──
  B(0, 0.5, 30, 17, 1, 7.5, C.marble, 2);
  B(0, 3.1, 30, 12.5, 4.2, 5.8, C.hall, 5);
  B(0, 2.3, 32.95, 6.8, 3.4, 0.5, [0.1, 0.02, 0.02], 4);         // door band
  H(0, 5.2, 30, 14, 2.9, 6.8);
  B(0, 8.1, 30, 7.2, 0.5, 0.7, C.gold, 3);
  B(-3.9, 8.3, 30, 0.8, 1.1, 0.9, C.gold, 3);
  B(3.9, 8.3, 30, 0.8, 1.1, 0.9, C.gold, 3);

  // ── 太和殿 (Hall of Supreme Harmony) @ z=0 — the centerpiece ──
  B(0, 0.6, 0, 30, 1.2, 18, C.marble, 2);                        // 三層須彌座
  B(0, 1.7, 0, 26, 1.0, 15.5, C.marble, 2);
  B(0, 2.7, 0, 22, 1.0, 13, C.marble, 2);
  B(0, 1.35, 11.2, 6, 1.5, 3, C.marble, 2);                      // south stairs
  B(0, 0.55, 13.8, 7.5, 0.7, 3, C.marble, 2);
  B(-8.6, 3.45, 3.5, 0.8, 1.3, 0.8, C.gold, 3);                  // 日晷/銅龜/銅鶴
  B(8.6, 3.45, 3.5, 0.8, 1.3, 0.8, C.gold, 3);
  B(0, 3.45, 5, 0.8, 1.3, 0.8, C.gold, 3);
  B(0, 5.2, 0, 18, 5, 10, C.hall, 5);                            // 殿身
  H(0, 7.7, 0, 21, 2.3, 12);                                     // 下檐 (double eave)
  B(0, 8.9, 0, 13.5, 2.4, 7.5, C.hall, 5);                       // 上層殿身
  H(0, 10.1, 0, 15.5, 3.3, 8.5);                                 // 上檐
  B(0, 13.4, 0, 7.6, 0.6, 1.0, C.gold, 3);                       // 正脊
  B(-4.1, 13.7, 0, 1.1, 1.5, 1.1, C.gold, 3);                    // 鴟吻
  B(4.1, 13.7, 0, 1.1, 1.5, 1.1, C.gold, 3);

  // ── 中和殿 (square hall, 攢尖 roof) @ z≈-11 ──
  B(0, 0.5, -11, 12, 1, 10, C.marble, 2);
  B(0, 3, -11, 8, 4, 6.5, C.hall, 5);
  P(0, 5, -11, 9.5, 4.0, 8);
  B(0, 9.6, -11, 0.45, 1.6, 0.45, C.gold, 3);                    // gilded spire

  // ── 保和殿 @ z≈-19.5 ──
  B(0, 0.5, -19.5, 22, 1, 12, C.marble, 2);
  B(0, 1.4, -19.5, 18, 0.8, 10, C.marble, 2);
  B(0, 3.8, -19.5, 15, 4.6, 8.5, C.hall, 5);
  H(0, 6.1, -19.5, 17, 3.4, 10);
  B(0, 9.5, -19.5, 8, 0.5, 0.8, C.gold, 3);
  B(-4.3, 9.75, -19.5, 0.9, 1.2, 1.0, C.gold, 3);
  B(4.3, 9.75, -19.5, 0.9, 1.2, 1.0, C.gold, 3);

  // ── 乾清宮 (inner court) @ z≈-32 ──
  B(0, 0.5, -32, 14, 1, 9, C.marble, 2);
  B(0, 2.9, -32, 10.5, 3.8, 6, C.hall, 5);
  H(0, 4.8, -32, 12, 3.0, 7.2);
  B(0, 7.8, -32, 6, 0.45, 0.7, C.gold, 3);

  // ── 神武門 (north gate) @ z≈-50 ──
  B(0, 2.5, -50, 20, 5, 6, C.wall);
  B(0, 1.7, -46.9, 3.4, 3.4, 0.6, [0.08, 0.02, 0.02], 4);
  B(0, 6.2, -50, 12, 2.4, 5, C.hall, 5);
  H(0, 7.4, -50, 13.5, 2.8, 6);
  B(0, 10.2, -50, 6.6, 0.5, 0.7, C.gold, 3);
  B(-3.6, 10.45, -50, 0.8, 1.2, 0.9, C.gold, 3);
  B(3.6, 10.45, -50, 0.8, 1.2, 0.9, C.gold, 3);

  // ── perimeter walls + 角樓 ──
  B(-24.5, 2, 52, 19, 4, 1.6, C.wall);                           // south (beside 午門)
  B(24.5, 2, 52, 19, 4, 1.6, C.wall);
  B(-24, 2, -52, 20, 4, 1.6, C.wall);                            // north (beside 神武門)
  B(24, 2, -52, 20, 4, 1.6, C.wall);
  B(-34, 2, 0, 1.6, 4, 104, C.wall);                             // east/west
  B(34, 2, 0, 1.6, 4, 104, C.wall);
  for (const sx of [-1, 1])                                       // corner turrets
    for (const sz of [-1, 1]) {
      const x = 34 * sx, z = 52 * sz;
      B(x, 2.2, z, 5.4, 4.4, 5.4, C.wall);
      B(x, 5.6, z, 3.8, 2.4, 3.8, C.hall, 5);
      H(x, 6.8, z, 5, 1.7, 5);
      P(x, 8.5, z, 3.7, 2.6, 3.7);
      B(x, 11.0, z, 0.4, 1.4, 0.4, C.gold, 3);
    }

  // ── moat (筒子河) just outside the walls ──
  B(0, -0.31, 57, 88, 0.8, 6, C.water, 6);
  B(0, -0.31, -57, 88, 0.8, 6, C.water, 6);
  B(-39.5, -0.31, 0, 6, 0.8, 106, C.water, 6);
  B(39.5, -0.31, 0, 6, 0.8, 106, C.water, 6);

  // ── 景山 + 萬春亭 (north of 神武門) ──
  HILL(0, -1, -73, 26, 9, 18, C.hill);
  B(0, 7.2, -72, 3.6, 1.8, 3.6, C.hall, 5);
  P(0, 8.1, -72, 4.6, 2.4, 4.6);
  B(0, 10.4, -72, 0.4, 1.2, 0.4, C.gold, 3);

  // ── trees (courtyard groves + Jingshan forest) ──
  const tree = (x, z, s = 1) => {
    B(x, 0.6 * s, z, 0.5 * s, 1.2 * s, 0.5 * s, C.trunk);
    P(x, 2.1 * s, z, 2.6 * s, 3.0 * s, 2.6 * s, C.leaf).mode = 7;
    P(x, 4.1 * s, z, 1.7 * s, 2.4 * s, 1.7 * s, C.leaf).mode = 7;
  };
  // (P() returns the part, so the .mode overrides above are real writes)
  for (const [x, z, s] of [
    [-22, 16, 1.1], [-27, 20, 0.9], [-18, 24, 0.8], [22, 16, 1.0], [26, 21, 1.2],
    [19, 25, 0.9], [-21, -28, 1.0], [21, -28, 0.9], [-25, -38, 1.1], [24, -38, 1.0],
    [-20, -44, 0.8], [19, -44, 1.0],
  ]) tree(x, z, s);
  for (let i = 0; i < 12; i++) {
    const a = i * 2.399963;                                       // golden-angle scatter
    tree(Math.cos(a) * (7 + (i % 5) * 3.4), -66 - (i % 6) * 2.6, 0.7 + (i % 3) * 0.28);
  }
}

// instance storage: 12 floats/instance — pos.xyz+rotY · scale.xyz+pad · rgb+mode
// One buffer PER draw kind: all draws share byte 0, and queue.writeBuffer ops
// enqueued before a frame all land before its passes execute — a single buffer
// rewritten per draw would let the last write clobber the earlier draws.
function packInstances() {
  const pack = (kind) => {
    const list = parts.filter((p) => p.kind === kind);
    const f = new Float32Array(Math.max(1, list.length) * 12);
    list.forEach((p, i) => {
      f.set([p.x, p.y, p.z, 0, p.sx, p.sy, p.sz, 0, p.c[0], p.c[1], p.c[2], p.mode], i * 12);
    });
    return { data: f, count: list.length };
  };
  return { box: pack("box"), hip: pack("hip"), pyr: pack("pyr"), hill: pack("hill") };
}

// ── shaders ──────────────────────────────────────────────────────────────────
const BODY_SHADER = /* wgsl */ `
struct Cam { viewProjection: mat4x4f, camPos: vec4f }
@group(0) @binding(0) var<uniform> cam: Cam;
struct Tm { time: f32, base: f32, pad: vec2f }
@group(0) @binding(1) var<uniform> tm: Tm;
struct Inst { posRot: vec4f, scale: vec4f, colMode: vec4f }
@group(0) @binding(2) var<storage, read> inst: array<Inst>;

const SUN = ${SUN_DIR_WGSL};
const FOG = vec3f(0.78, 0.68, 0.55);

fn hash11(n: f32) -> f32 { return fract(sin(n) * 43758.5453123); }
fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123); }
fn hash31(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453123); }
fn vnoise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3f(1,0,0)), u.x), mix(hash31(i + vec3f(0,1,0)), hash31(i + vec3f(1,1,0)), u.x), u.y),
    mix(mix(hash31(i + vec3f(0,0,1)), hash31(i + vec3f(1,0,1)), u.x), mix(hash31(i + vec3f(0,1,1)), hash31(i + vec3f(1,1,1)), u.x), u.y),
    u.z);
}
fn fbm3(p: vec3f) -> f32 {
  var v = 0.0; var amp = 0.5; var q = p;
  for (var i = 0; i < 3; i++) { v += amp * vnoise3(q); amp *= 0.5; q = q * 2.07 + vec3f(13.7); }
  return v;
}
fn rotY(p: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) worldN: vec3f,
  @location(2) localN: vec3f,
  @location(3) localPos: vec3f,
  @location(4) col: vec4f,
  @location(5) vScale: vec3f,
}

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f,
                   @builtin(instance_index) idx: u32) -> VOut {
  let I = inst[u32(tm.base) + idx];
  var out: VOut;
  out.worldPos = I.posRot.xyz + rotY(position * I.scale.xyz, I.posRot.w);
  out.worldN = rotY(normal / max(I.scale.xyz, vec3f(1e-4)), I.posRot.w);
  out.localN = normal;
  out.localPos = position;
  out.col = I.colMode;
  out.vScale = I.scale.xyz;
  out.position = cam.viewProjection * vec4f(out.worldPos, 1.0);
  return out;
}

@fragment fn fs_main(in: VOut) -> @location(0) vec4f {
  let N = normalize(in.worldN);
  let V = normalize(cam.camPos.xyz - in.worldPos);
  let mode = in.col.a;
  var alb = in.col.rgb;
  var specStr = 0.0;
  var specPow = 28.0;

  if (mode < 0.5) {                                   // matte (walls, trunks…)
    alb *= 0.9 + 0.1 * fbm3(in.worldPos * 0.9);
    // pale 女兒牆-style top band on vertical faces
    let band = (1.0 - abs(in.localN.y)) * smoothstep(0.36, 0.46, in.localPos.y);
    alb = mix(alb, vec3f(0.72, 0.64, 0.52), band * 0.75);
  } else if (mode < 1.5) {                            // glazed roof tiles
    // tile ribs in WORLD space, hard-switched at the hip (|N.x| = 0.5): a
    // blended mix of the x/z fields interferes into plume fringes on wide
    // roofs, and local coords compress the ribs near the ridge.
    let ribCoord = select(in.worldPos.z, in.worldPos.x, abs(in.localN.x) < 0.5);
    let ribI = floor(ribCoord / 0.55);
    let rib = fract(ribCoord / 0.55);
    let ribShade = 0.92 + 0.08 * smoothstep(0.0, 0.35, rib) * smoothstep(1.0, 0.65, rib);
    alb *= ribShade * (0.97 + 0.06 * hash11(ribI));
    specStr = 0.05; specPow = 50.0;                   // faint glazed glint
  } else if (mode < 2.5) {                            // 白玉 marble
    let sp = fbm3(in.worldPos * 7.0);
    alb *= 0.94 + 0.06 * sp;
    alb = mix(alb, vec3f(0.62, 0.60, 0.55), smoothstep(0.75, 0.9, sp) * 0.18);
  } else if (mode < 3.5) {                            // gold
    let fv = 0.5 + 0.5 * dot(N, V);
    alb = mix(vec3f(0.55, 0.36, 0.08), vec3f(1.0, 0.85, 0.4), fv);
    specStr = 1.1; specPow = 70.0;
  } else if (mode < 4.5) {                            // door with gold studs
    let g = abs(vec2(in.localPos.x, in.localPos.y)) * vec2(8.0, 5.0);
    let cell = floor(g);
    let d = length(fract(g) - vec2(0.5));
    let stud = smoothstep(0.16, 0.1, d);
    alb = mix(alb, vec3f(0.78, 0.6, 0.22), stud);
    specStr = stud * 0.3; specPow = 60.0;
  } else if (mode < 5.5) {                            // hall body: columns + 彩畫
    let h = in.localPos.y + 0.5;                      // 0 bottom → 1 top
    let colCoord = mix(in.localPos.x, in.localPos.z, abs(in.localN.x));
    let cs = abs(fract(colCoord * 7.0) - 0.5) * 2.0;
    let column = 1.0 - smoothstep(0.22, 0.38, cs);
    var body = mix(alb * 1.08, alb * 0.62, column);   // lighter wall between red columns
    let door = (1.0 - smoothstep(0.26, 0.3, abs(colCoord))) * step(h, 0.6);
    body = mix(body, vec3f(0.16, 0.03, 0.02), door);
    let s = 0.5 + 0.5 * sin(colCoord * 24.0);
    var paint = mix(vec3f(0.07, 0.2, 0.17), vec3f(0.45, 0.55, 0.1), smoothstep(0.72, 0.9, s) * 0.5);
    paint = mix(paint, vec3f(0.85, 0.65, 0.2), smoothstep(0.9, 1.0, s) * 0.5);
    body = mix(body, paint, smoothstep(0.6, 0.64, h) * (1.0 - smoothstep(0.78, 0.82, h)));
    body = mix(body, vec3f(0.2, 0.1, 0.06), smoothstep(0.82, 0.86, h)); // eave boards
    alb = body;
  } else if (mode < 6.5) {                            // water
    let w = fbm3(in.worldPos * vec3f(0.5, 2.0, 0.5) + vec3f(tm.time * 0.1, 0.0, tm.time * 0.13));
    alb = mix(alb * 0.6, vec3f(0.35, 0.48, 0.48), 0.35 + 0.4 * w);
    let R = reflect(-SUN, vec3f(0.0, 1.0, 0.0));
    specStr = pow(max(dot(R, V), 0.0), 120.0) * 1.6;  // sun glitter
    specPow = 8.0;
  } else if (mode < 7.5) {                            // foliage
    alb *= 0.65 + 0.6 * fbm3(in.worldPos * 1.6);
    alb *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 4.0, in.worldPos.y));
  } else if (mode < 8.5) {                            // brick paving
    let g = abs(fract(in.worldPos.xz * 0.55) - 0.5) * 2.0;
    let line = smoothstep(0.9, 0.98, max(g.x, g.y));
    let tone = 0.85 + 0.2 * hash21(floor(in.worldPos.xz * 0.55));
    alb *= tone * (1.0 - 0.3 * line);
  } else {                                            // hill
    alb = mix(alb * 0.7, alb * 1.15, fbm3(in.worldPos * 0.5));
  }

  let diff = max(dot(N, SUN), 0.0);
  let sky = mix(vec3f(0.34, 0.34, 0.38), vec3f(0.7, 0.72, 0.78), N.y * 0.5 + 0.5);
  let sunCol = vec3f(1.0, 0.8, 0.58) * 1.2;
  var col = alb * (sky * 0.42 + sunCol * diff);
  if (specStr > 0.0) {
    let Hw = normalize(SUN + V);
    col += sunCol * pow(max(dot(N, Hw), 0.0), specPow) * specStr;
  }
  // distance haze toward the warm horizon
  let d = length(cam.camPos.xyz - in.worldPos);
  col = mix(col, FOG, 1.0 - exp(-d * 0.0042));
  return vec4f(col, 1.0);
}
`;

const POST_SHADER = /* wgsl */ `
struct Post { sun: vec4f, time: f32, aspect: f32, pad: vec2f }
@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123); }
fn vnoise2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1, 0)), u.x),
             mix(hash21(i + vec2f(0, 1)), hash21(i + vec2f(1, 1)), u.x), u.y);
}
fn fbm2(p: vec2f) -> f32 {
  var v = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 4; i++) { v += a * vnoise2(q); a *= 0.5; q = q * 2.1 + vec2f(17.3); }
  return v;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // uv.y is 0 at the TOP of the screen — flip so "h" grows with height
  let h = 1.0 - uv.y;
  // golden-hour sky: warm horizon → deep blue zenith
  let hor = smoothstep(0.32, 0.5, h);
  let zen = smoothstep(0.45, 0.9, h);
  var sky = mix(vec3f(0.93, 0.68, 0.42), vec3f(0.58, 0.65, 0.74), hor);
  sky = mix(sky, vec3f(0.2, 0.31, 0.52), zen);

  // thin cloud streaks, lit warm from the sun side
  let cl = fbm2(vec2f(uv.x * 3.2 + post.time * 0.004, h * 16.0));
  let cm = smoothstep(0.55, 0.8, cl) * smoothstep(0.42, 0.55, h) * (1.0 - smoothstep(0.72, 0.9, h));
  sky = mix(sky, vec3f(1.0, 0.83, 0.62), cm * 0.4);

  let s = textureSampleLevel(src, samp, uv, 0.0);
  var col = sky * (1.0 - s.a) + s.rgb;

  if (post.sun.w > 0.0) {
    let d = length((uv - post.sun.xy) * vec2f(post.aspect, 1.0));
    col += vec3f(1.0, 0.75, 0.45) * (smoothstep(0.02, 0.013, d) * 1.1 + exp(-d * 9.0) * 0.4 + exp(-d * 2.4) * 0.12) * post.sun.w;
  }
  col *= 1.0 - 0.28 * smoothstep(0.45, 0.85, length(uv - vec2f(0.5, 0.52)));
  return vec4f(col, 1.0);
}
`;

// ── scene assembly ───────────────────────────────────────────────────────────
export async function createPalaceScene(gpu) {
  buildLayout();
  const inst = packInstances();

  const boxGeo = geometry(gpu, box({ size: 1 }));
  const hillGeo = geometry(gpu, sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24 }));
  const hipGeo = hipRoofGeometry(gpu, { rf: 0.45 });
  const pyrGeo = hipRoofGeometry(gpu, { rf: 0.02, flare: 0.05, dip: 0.03, hPow: 1.2, segU: 14, segT: 7 });

  const mkBuf = (t) => storage(gpu, t.data.byteLength, "read");
  const boxBuf = mkBuf(inst.box);
  const hipBuf = mkBuf(inst.hip);
  const pyrBuf = mkBuf(inst.pyr);
  const hillBuf = mkBuf(inst.hill);
  for (const [buf, t] of [[boxBuf, inst.box], [hipBuf, inst.hip], [pyrBuf, inst.pyr], [hillBuf, inst.hill]])
    buf.write(t.data);

  const shader = { shader: BODY_SHADER, cull: "back" };
  const boxDraw = draw(gpu, { ...shader, geometry: boxGeo, instances: inst.box.count });
  const hillDraw = draw(gpu, { ...shader, geometry: hillGeo, instances: inst.hill.count });
  const hipDraw = draw(gpu, { ...shader, geometry: hipGeo, instances: inst.hip.count });
  const pyrDraw = draw(gpu, { ...shader, geometry: pyrGeo, instances: inst.pyr.count });
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
    const tgt = [0, 5, 2];
    const eye = [
      tgt[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      tgt[1] + dist * Math.sin(pitch),
      tgt[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const view = lookAt(eye, tgt, [0, 1, 0]);
    const proj = perspective(50 * (Math.PI / 180), aspect, 0.1, 600);
    const vp = matMul(proj, view);
    // project the sun disc: clip = vp · (SUN_DIR * 500, 1)
    const sw = [SUN_DIR[0] * 500, SUN_DIR[1] * 500, SUN_DIR[2] * 500, 1];
    const clip = [
      vp[0] * sw[0] + vp[4] * sw[1] + vp[8] * sw[2] + vp[12] * sw[3],
      vp[1] * sw[0] + vp[5] * sw[1] + vp[9] * sw[2] + vp[13] * sw[3],
      vp[3] * sw[0] + vp[7] * sw[1] + vp[11] * sw[2] + vp[15] * sw[3],
    ];
    const sun = clip[2] > 0.001
      ? [clip[0] / clip[2] * 0.5 + 0.5, 0.5 - clip[1] / clip[2] * 0.5, 1]
      : [0, 0, 0];
    return { vp, eye, sun };
  }

  function render(timeSec, camState, canvasTarget) {
    const cam = cameraFrom(camState.yaw, camState.pitch, camState.dist);
    frame(gpu, (f) => {
      f.pass({ target: sceneTarget, clear: [0, 0, 0, 0] }, (pass) => {
        const camU = { viewProjection: cam.vp, camPos: [...cam.eye, 0] };
        boxDraw.set({ cam: camU, tm: { time: timeSec, base: 0, pad: [0, 0] }, inst: boxBuf });
        pass.draw(boxDraw);
        hipDraw.set({ cam: camU, tm: { time: timeSec, base: 0, pad: [0, 0] }, inst: hipBuf });
        pass.draw(hipDraw);
        pyrDraw.set({ cam: camU, tm: { time: timeSec, base: 0, pad: [0, 0] }, inst: pyrBuf });
        pass.draw(pyrDraw);
        hillDraw.set({ cam: camU, tm: { time: timeSec, base: 0, pad: [0, 0] }, inst: hillBuf });
        pass.draw(hillDraw);
      });
      f.pass({ target: canvasTarget, clear: [0.7, 0.6, 0.45, 1] }, (pass) => {
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
    stats: { boxes: inst.box.count, hips: inst.hip.count, pyrs: inst.pyr.count, hills: inst.hill.count },
    dispose() {
      sceneTarget?.dispose?.();
      for (const d of [boxDraw, hillDraw, hipDraw, pyrDraw, postEffect]) d.dispose?.();
      gpu.dispose();
    },
  };
}
