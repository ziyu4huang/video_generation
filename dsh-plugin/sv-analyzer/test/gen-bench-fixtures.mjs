// gen-bench-fixtures.mjs — deterministic HDL generator for the benchmark.
//
// Generates graded-size SystemVerilog fixtures under test/.bench/ with a
// known ground-truth design summary (module/port/signal/always/assign/
// instance counts baked in by construction), so the benchmark can assert
// extraction accuracy without any external tool.
//
// Usage: node test/gen-bench-fixtures.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '.bench')
mkdirSync(outDir, { recursive: true })

// One generated module ≈ 20 lines. Deterministic: no RNG, output is a pure
// function of (index), so ground truth is exact.
function genModule(i) {
  const inst = i > 0 ? `
  // leaf instance
  bench_leaf #(.W(W)) u_leaf_${i} (.clk(clk), .rst_n(rst_n), .d(ctl_${i}), .q(stat_${i}));` : ''
  return `module bench_mod_${i} #(
  parameter int W = ${8 + (i % 4)}
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic [W-1:0]     din_${i},
  output logic [W-1:0]     dout_${i},
  output logic             valid_${i}
);
  logic [W-1:0] acc_${i};
  logic [W-1:0] next_${i};
  logic             ctl_${i};
  logic             stat_${i};

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      acc_${i}   <= '0;
      valid_${i} <= 1'b0;
    end else begin
      acc_${i}   <= next_${i};
      valid_${i} <= (next_${i} == W'(0));
    end
  end

  assign next_${i}  = acc_${i} + din_${i};
  assign dout_${i}  = acc_${i};${inst}
endmodule
`
}

function genLeaf() {
  return `module bench_leaf #(
  parameter int W = 8
) (
  input  logic         clk,
  input  logic         rst_n,
  input  logic [W-1:0] d,
  output logic [W-1:0] q
);
  logic [W-1:0] q_q;
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) q_q <= '0;
    else        q_q <= d;
  end
  assign q = q_q;
endmodule
`
}

// Suite: name -> { moduleCount }. Module 0..N-1 each instance a leaf when i>0.
const SUITES = [
  { name: 'gen_xs', modules: 2 },      // ~70 lines (modules + instance wiring)
  { name: 'gen_s', modules: 5 },       // ~160 lines
  { name: 'gen_m', modules: 15 },      // ~450 lines
  { name: 'gen_l', modules: 75 },      // ~2190 lines
  { name: 'gen_xl', modules: 300 },    // ~8700 lines
]

const manifest = []
for (const suite of SUITES) {
  let src = '// generated benchmark fixture — deterministic, do not edit\n'
  let instances = 0
  for (let i = 0; i < suite.modules; i++) {
    src += genModule(i)
    if (i > 0) instances++
  }
  src += genLeaf()
  const path = join(outDir, `${suite.name}.sv`)
  writeFileSync(path, src)

  // Ground truth, matching sv_analyze's stats vocabulary.
  const perModule = {
    ports: 5,
    signals: 4,
    always_blocks: 1,
    continuous_assigns: 2,
  }
  const leaf = {
    modules: 1,
    ports: 4,
    signals: 1,
    always_blocks: 1,
    continuous_assigns: 1,
    instances: 0,
  }
  manifest.push({
    name: suite.name,
    path,
    lines: src.split('\n').length,
    bytes: Buffer.byteLength(src),
    // Keys must match sv_analyze's stats vocabulary exactly.
    truth: {
      modules: suite.modules + leaf.modules,
      ports: suite.modules * perModule.ports + leaf.ports,
      signals: suite.modules * perModule.signals + leaf.signals,
      always_blocks: suite.modules * perModule.always_blocks + leaf.always_blocks,
      instances,
    },
  })
}

// One deliberately broken file: measures the issues-reporting path (analyze
// still returns a payload, but with parse issues — no ground truth).
const broken = `module bench_broken #((
  parameter W = 8
) (
  input logic clk
  output logic [W-1:0] q   // missing comma
);
  logic [W-1:0] q_q
  always_ff @(posedge clk q_q <= 1'b0;   // garbage
  assign q = ;
endmodule
`
const brokenPath = join(outDir, 'gen_broken.sv')
writeFileSync(brokenPath, broken)
manifest.push({ name: 'gen_broken', path: brokenPath, lines: broken.split('\n').length, bytes: Buffer.byteLength(broken), truth: null })

console.log(JSON.stringify(manifest, null, 2))
