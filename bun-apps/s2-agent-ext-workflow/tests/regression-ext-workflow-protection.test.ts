/**
 * Workflow-layer counterpart to the engine RCA guards
 * (see ./regression-rca.test.ts, RCA#4/#7).
 *
 * The engine converts a recoverable failure / schema-non-compliance / terminal
 * error to `null` (recoverable exhausted) or a throw (non-recoverable). The
 * s2-agent-ext-* L2 workflows (flux2, krea2) MUST NOT silently drop either case
 * via `.catch(() => null)` + `.filter(Boolean)` — the canonical null→default
 * smell. Instead a failed judge becomes an explicit `{scored:false,...}` entry,
 * `judgments` stays one-entry-per-output, `ok` is false, and `needsReview` is
 * true.
 *
 * These tests load the ACTUAL workflow source from each extension package and
 * execute it through runWorkflow with a mocked agent runner — so they fail the
 * moment someone reverts the protection in either script.
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runWorkflow } from "../src/workflow.js";

const REPO = path.resolve(import.meta.dir, "../../..");
const WORKFLOWS = [
  { ext: "flux2", file: "bun-apps/s2-agent-ext-flux2/workflows/test-flux2-e2e.js" },
  { ext: "krea2", file: "bun-apps/s2-agent-ext-krea2/workflows/test-krea2-e2e.js" },
];

type JudgeMode = "null" | "throw";

/**
 * Mock agent runner. The Generate agent succeeds with fake PNG paths; every
 * Judge agent fails — via the two real engine paths: `null` (recoverable
 * exhausted, the run() never even reached because agentRetries:0 short-circuits)
 * or a non-recoverable throw (PROVIDER_USAGE_LIMIT-classified → re-thrown by the
 * engine, caught by the workflow's judgeOne()).
 */
function makeMockAgent(judgeMode: JudgeMode, paths: string[]) {
  return {
    async run(prompt: string) {
      const p = String(prompt ?? "");
      if (/Generate one/.test(p)) {
        return { ok: true, paths, binaryReady: true, error: "" };
      }
      if (/Score this/.test(p)) {
        if (judgeMode === "throw") {
          // Wording wrapError() classifies as PROVIDER_USAGE_LIMIT (non-recoverable)
          // → engine re-throws → judgeOne's catch records {scored:false,error}.
          throw new Error("Error 429: too many requests");
        }
        return null;
      }
      return null;
    },
  };
}

for (const { ext, file } of WORKFLOWS) {
  const abs = path.resolve(REPO, file);
  const source = await Bun.file(abs).text();

  describe(`L2 workflow silent-failure protection — ${ext}`, () => {
    for (const mode of ["null", "throw"] as JudgeMode[]) {
      it(`judge ${mode} failure → ok=false, needsReview=true, one scored:false entry per output`, async () => {
        const paths = ["/tmp/wf-e2e-test/a.png", "/tmp/wf-e2e-test/b.png"];
        const result = await runWorkflow(source, {
          cwd: REPO,
          // agentRetries:0 short-circuits the engine's attempt loop → agent()
          // returns null without calling run() (the realistic terminal path).
          // For the throw mode we bump to 1 so run() actually fires and throws.
          agentRetries: mode === "throw" ? 1 : 0,
          agent: makeMockAgent(mode, paths),
          persistLogs: false,
          args: {
            repoRoot: REPO,
            // Two prompts so we can assert the per-output invariant on >1 output.
            prompts: ["prompt-a", "prompt-b"],
            outDir: "/tmp/wf-e2e-test",
          },
        });

        const r = result.result as {
          ok: boolean;
          ext: string;
          outputs: string[];
          judgments: Array<{ scored: boolean; path?: string; error?: string; needsReview?: boolean }>;
          needsReview: boolean;
          summary: string;
          genError: string;
        };

        assert.equal(r.ext, ext, "ext tag");
        assert.equal(r.genError, "", "generation succeeded — no genError");
        assert.equal(r.ok, false, "ok MUST be false when any judge failed");
        assert.equal(r.needsReview, true, "needsReview MUST flag the silent-failure path");
        assert.equal(r.judgments.length, paths.length, "judgments is one entry per output (no drop)");

        for (const j of r.judgments) {
          assert.equal(j.scored, false, "every judge failed → every entry scored:false");
          assert.ok(j.error && j.error.length > 0, "scored:false entries MUST carry a reason");
        }
        assert.ok(
          /needs review|could not be scored/i.test(r.summary),
          `summary should flag unscored, got: ${r.summary}`,
        );
      });
    }

    it("generation null (agent returned no result) → ok=false, genError carries a real reason, no outputs", async () => {
      // agentRetries:0 → Generate agent() returns null → outputs=[] → workflow
      // must surface WHY (genError) instead of a bare "no outputs generated".
      const result = await runWorkflow(source, {
        cwd: REPO,
        agentRetries: 0,
        agent: {
          async run() {
            return null;
          },
        },
        persistLogs: false,
        args: { repoRoot: REPO, prompts: ["prompt-a"], outDir: "/tmp/wf-e2e-test" },
      });

      const r = result.result as { ok: boolean; outputs: string[]; genError: string; needsReview: boolean };
      assert.equal(r.ok, false);
      assert.equal(r.outputs.length, 0);
      assert.ok(r.genError && r.genError.length > 0, "genError must surface the null-generation reason");
      assert.equal(r.needsReview, false, "no outputs to review; the failure is in generation, not judging");
    });
  });

  // ─── pose_dsg Judge gating (anatomy_pass && faithfulness) ───────────────
  // When `poses` is passed (entries lifted from poses.json), the workflow drives
  // generation from pose prompts AND judges each output with the atomic pose_dsg
  // validator instead of the holistic score. Pass requires anatomy_pass===true
  // AND faithfulness>=threshold (0.8 default). The per-pose × per-atom matrix
  // records which atoms failed so a commit can be diffed atom-by-atom.
  describe(`L2 workflow pose_dsg gating — ${ext}`, () => {
    type PoseVerdict = {
      anatomy_pass: boolean;
      faithfulness: number;
      atoms: Array<{ id: string; q: string; present: boolean; confidence?: number }>;
    };

    function makePoseMock(verdict: PoseVerdict, failMode: JudgeMode | "none" = "none") {
      return {
        async run(prompt: string) {
          const p = String(prompt ?? "");
          if (/Generate one/.test(p)) {
            return {
              ok: true,
              paths: ["/tmp/wf-e2e-test/p0.png", "/tmp/wf-e2e-test/p1.png"],
              binaryReady: true,
              error: "",
            };
          }
          if (/Validate this generated pose/.test(p)) {
            if (failMode === "throw") throw new Error("Error 429: too many requests");
            if (failMode === "null") return null; // recoverable exhausted → agent() returns null
            return {
              ok: true,
              path: "/tmp/wf-e2e-test/pN.png",
              poseId: "",
              anatomy_pass: verdict.anatomy_pass,
              faithfulness: verdict.faithfulness,
              anatomy: { limb_count: true, hands: true, face: true, pose_plausible: true },
              atoms: verdict.atoms,
              issues: [],
              rawTail: "",
            };
          }
          return null;
        },
      };
    }

    const POSES_ARG = [
      {
        id: "L3-01",
        prompt: "a woman in a dancer's pose",
        failure_modes: ["pose-plausibility"],
        atoms: [
          { id: "a1", q: "she stands on one leg" },
          { id: "a2", q: "her other leg is lifted behind her" },
          { id: "a4", q: "one arm reaches back toward the raised ankle" },
        ],
      },
      {
        id: "L4-02",
        prompt: "two women holding hands",
        failure_modes: ["extra-limbs"],
        atoms: [
          { id: "a1", q: "exactly two women are shown" },
          { id: "a3", q: "they are holding each other's hand" },
        ],
      },
    ];

    const common = {
      cwd: REPO,
      agentRetries: 1,
      persistLogs: false,
      args: { repoRoot: REPO, poses: POSES_ARG, outDir: "/tmp/wf-e2e-test" },
    } as const;

    it("anatomy_pass + high faithfulness → ok=true, poseMatrix one entry per pose with atoms", async () => {
      const result = await runWorkflow(source, {
        ...common,
        agent: makePoseMock({
          anatomy_pass: true,
          faithfulness: 0.9,
          atoms: [
            { id: "a1", q: "x", present: true, confidence: 0.9 },
            { id: "a2", q: "x", present: true, confidence: 0.9 },
          ],
        }),
      });
      const r = result.result as {
        ok: boolean;
        poseMatrix: Array<{
          poseId: string;
          anatomy_pass: boolean;
          faithfulness: number;
          atoms: Array<{ id: string; present: boolean }>;
          failed_atoms: string[];
        }>;
        summary: string;
      };
      assert.equal(r.ok, true, "anatomy ok + faith 0.9 should pass");
      assert.equal(r.poseMatrix.length, POSES_ARG.length, "poseMatrix one entry per pose");
      for (const m of r.poseMatrix) {
        assert.equal(m.anatomy_pass, true);
        assert.ok(m.faithfulness >= 0.8);
        assert.ok(m.atoms.length >= 2, "atoms carried through for per-atom diffing");
        assert.equal(m.failed_atoms.length, 0);
      }
    });

    it("anatomy_pass=false → ok=false even with faithfulness=1.0 (hard gate)", async () => {
      const result = await runWorkflow(source, {
        ...common,
        agent: makePoseMock({
          anatomy_pass: false,
          faithfulness: 1.0,
          atoms: [{ id: "a1", q: "x", present: true }],
        }),
      });
      const r = result.result as { ok: boolean; summary: string; poseMatrix: Array<{ anatomy_pass: boolean }> };
      assert.equal(r.ok, false, "anatomy_pass=false MUST fail regardless of faithfulness");
      assert.ok(/failed poses/i.test(r.summary), `summary should name failed poses, got: ${r.summary}`);
      assert.ok(r.poseMatrix.every((m) => m.anatomy_pass === false));
    });

    it("faithfulness below threshold → ok=false (anatomy alone is not enough)", async () => {
      const result = await runWorkflow(source, {
        ...common,
        agent: makePoseMock({
          anatomy_pass: true,
          faithfulness: 0.4,
          atoms: [
            { id: "a1", q: "x", present: false },
            { id: "a2", q: "x", present: true },
          ],
        }),
      });
      const r = result.result as {
        ok: boolean;
        poseMatrix: Array<{
          faithfulness: number;
          failed_atoms: string[];
          atoms: Array<{ id: string; present: boolean }>;
        }>;
      };
      assert.equal(r.ok, false, "faithfulness 0.4 < 0.8 threshold must fail");
      // failed_atoms derived from atoms present===false — the per-atom signal
      // that survives even when the aggregate flipped the gate.
      for (const m of r.poseMatrix) {
        assert.ok(m.failed_atoms.includes("a1"), "the absent atom is recorded in failed_atoms");
        assert.equal(m.atoms.find((x) => x.id === "a1")?.present, false);
      }
    });

    it("pose judge throw / null → scored:false, needsReview:true, ok=false (silent-failure protection carries into pose mode)", async () => {
      for (const mode of ["null", "throw"] as JudgeMode[]) {
        const result = await runWorkflow(source, {
          ...common,
          agentRetries: mode === "throw" ? 1 : 0,
          agent: makePoseMock({ anatomy_pass: true, faithfulness: 1.0, atoms: [] }, mode),
        });
        const r = result.result as {
          ok: boolean;
          needsReview: boolean;
          judgments: Array<{ scored: boolean; style?: string; error?: string }>;
        };
        assert.equal(r.ok, false, `mode=${mode}: a failed pose judge must fail the run`);
        assert.equal(r.needsReview, true, `mode=${mode}: needsReview must flag the unscored pose`);
        assert.equal(r.judgments.length, POSES_ARG.length);
        for (const j of r.judgments) {
          assert.equal(j.scored, false);
          assert.equal(j.style, "pose_dsg");
          assert.ok(j.error && j.error.length > 0);
        }
      }
    });
  });
}
