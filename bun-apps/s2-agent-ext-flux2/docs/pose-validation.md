# Complex-pose validation for the flux2 image agent

This doc captures **(a)** why a holistic 1-10 VLM score is the wrong tool for
complex poses, **(b)** the research-backed method we adopted instead, and
**(c)** how to drive it through `run.py caption --style pose_dsg` + the
`workflows/poses.json` fixture. It is the reference the L2 e2e workflow and any
future pose-regression suite build on.

The same method applies to krea2 (and any `s2-agent-ext-*`) — it lives in the
shared `run.py caption` scorer, not in flux2-specific code.

---

## 1. The problem: holistic scores over-praise complex poses

The existing `--style score` asks the VLM for six 1-10 dimensions. For a clean
still life that is fine. For a **complex human pose** it is the wrong unit of
analysis, for two compounding reasons documented across the 2024-2025
evaluation literature:

1. **VLMs over-score.** A clean-looking apple routinely gets `overall=9,
   prompt_adherence=10`. We already logged this in
   `vlm-caption-overpraise-qa-gap`. A pose that *looks* photographic can still
   be wrong (hand on the wrong side, missing the requested 3/4 view, six
   fingers) and still score 9, because the VLM averages a holistic impression.
2. **Complex poses fail locally, not globally.** AbHuman/HumanRefiner (ECCV 2024)
   annotated 147K anomalies across 56K synthesized humans and found failure
   concentrates in a few body parts — **limb count, twisted hands, incorrect
   limb position, face distortion** — not "overall quality". A single
   `overall=8` erases exactly the signal that matters.

The community consensus in 2025 LLM-as-a-judge work is direct: **ditch the 1-10
scale**, use fine-grained per-attribute rubrics.

---

## 2. The method (research-backed)

Three complementary layers, all driven through one VLM call per image (local MLX
VLMs are slow; per-atom VQA loops like raw DSG are impractical here, so we use
the batched / Soft-TIFA form).

### 2a. Atomic prompt faithfulness (DSG / TIFA / VQAScore)

Decompose the pose prompt into **atoms** — each a single yes/no proposition about
one thing (an object, a body attribute, a spatial relation, a viewpoint, a
count). The VLM verifies each atom against the image. **Faithfulness = atoms
true / atoms total.** This is far sharper than a holistic score: an atom failure
tells you *which* part of the prompt was ignored.

- **DSG** (Decomposed Scoring Graph) — hierarchical, dependency-aware; strongest
  on 3D spatial / complex limbs.
- **VQAScore** — one probabilistic VQA question; strongest on 2D spatial.
- **TIFA** — LLM-generates diverse questions from the prompt; reference-free,
  per-question interpretable.

Empirically ([arXiv 2509.21227](https://arxiv.org/html/2509.21227v1)): use **DSG
for 3D/pose**, VQAScore for 2D. `pose_dsg` is DSG-flavored.

### 2b. Anatomy gate (AbHuman / HumanBench)

Independent of the atoms — structural correctness any human image must satisfy.
Hard pass/fail, never averaged into a score:

| field | fails when |
| --- | --- |
| `limb_count` | not exactly 2 arms + 2 legs, or any extra/fused/duplicated limb |
| `hands` | any visible hand has >5 fingers, or fused/malformed/extra fingers |
| `face` | visible **and** distorted (asymmetric eyes, melting features). `n/a` when not visible — never fails |
| `pose_plausible` | any joint outside a plausible human range of motion (twisted/broken limbs) |

`anatomy_pass = false` if any of `limb_count`, `hands`, `pose_plausible` is
false, **or** `face` is false (visible + distorted). The shared `_DEFECT_BLOCK`
(skin/hands/face/structure) is reused inside the prompt so the gate and the
existing `score`/`review` styles cannot drift apart.

### 2c. Recompute aggregates in Python (the null→default lesson)

The model returns `faithfulness` and `anatomy_pass`, but we **never trust those
fields** — `parse_pose_dsg` recomputes `faithfulness` from the atoms and
`anatomy_pass` from the anatomy fields. A model arithmetic slip (it claims
`faithfulness=1.0` while half the atoms are `present:false`) cannot survive into
the stored verdict. This is the same lesson as the workflow-engine RCA: never
trust an aggregate you can recompute from its parts.

---

## 3. The `pose_dsg` style — API

```
run.py caption <IMAGE> --style pose_dsg --prompt "<POSE PROMPT>" [--atoms PATH|JSON]
```

- `--prompt` (required) — the original T2I pose prompt.
- `--atoms` (optional) — explicit atoms: a path to a JSON file
  `{"atoms":[{"id":"a1","q":"..."},...]}` or an inline JSON string, or a bare
  list `[{"id","q"}]`. **If omitted**, the VLM self-decomposes the prompt into
  5-10 atoms (TIFA-style).

Output (stored under `styles.pose_dsg` in `<image>.caption.json`, parsed +
recomputed in Python):

```jsonc
{
  "atoms": [{"id":"a1","q":"both hands on top of head","present":true,"confidence":0.9}],
  "faithfulness": 0.8,            // recomputed: present / total
  "anatomy": {"limb_count":true,"hands":true,"face":true,"pose_plausible":false},
  "anatomy_pass": false,          // recomputed from anatomy
  "issues": ["right elbow twisted beyond range of motion"],
  "summary": "good prompt match but pose is physically implausible"
}
```

**Pass/fail for a workflow:** `anatomy_pass === true && faithfulness >= threshold`
(e.g. 0.8). `anatomy_pass === false` is always a fail regardless of
faithfulness — a six-fingered hand is not redeemed by a correct background.

Notes:
- Single VLM call per image (batched). `--samples` is ignored for `pose_dsg`
  (its per-atom aggregation is incompatible with the score-style median).
- Combine with `--style score pose_dsg` (multi-style) to get both a holistic
  quality score and the atomic pose verdict in one `<image>.caption.json`.

---

## 4. The pose library fixture — `workflows/poses.json`

11 poses across 4 levels, each pre-decomposed into atoms and tagged with the
failure modes it stresses (mapped to the AbHuman taxonomy). Lift one pose's
atoms straight into `--atoms`:

```bash
# Generate to a pose_dsg image, then validate with that pose's explicit atoms:
POSE=$(jq -r '.levels[2].poses[0]' bun-apps/s2-agent-ext-flux2/workflows/poses.json)
PROMPT=$(echo "$POSE" | jq -r .prompt)
echo "$POSE" | jq '{atoms}' > /tmp/atoms.json
run.py caption output/pose.png --style pose_dsg --prompt "$PROMPT" --atoms /tmp/atoms.json
```

| Level | Stresses | Example |
| --- | --- | --- |
| 1 | hands — occlusion, finger fusion, foreshortening | both hands on top of head |
| 2 | limb position & viewpoint, partial occlusion | sitting cross-legged, 3/4 view |
| 3 | full-body complex structure + face | dancer's pose (nataraja) |
| 4 | multi-subject interaction (fused/extra limbs at handoffs) | two people holding hands |

Extend the file freely — every pose is just `{id, prompt, failure_modes, atoms}`.

---

## 5. Wiring into the L2 e2e workflow — IMPLEMENTED

The flux2/krea2 L2 workflow (`workflows/test-*-e2e.js`) Judge stage is now
**pose-aware**. The upgrade described below is shipped (not hypothetical); the
deterministic guard for it lives in
`bun-apps/s2-agent-ext-workflow/tests/regression-ext-workflow-protection.test.ts`
(`L2 workflow pose_dsg gating`).

How it works:

1. **Drive generation from `poses.json`.** Pass `args.poses` (entries lifted
   verbatim from `poses.json`: `{id, prompt, failure_modes, atoms:[{id,q}]}`).
   The workflow then generates one PNG per `pose.prompt` instead of the bare
   `prompts[]`, so each output carries a known `prompt` + `atoms`.
2. **`judgeOne()` branches on style.** When `POSES[i]` is present it calls
   `judgePose()` → `run.py caption <out> --style pose_dsg --prompt <p> --atoms
   <atoms.json>`; otherwise it falls back to the existing `judgeScore()` →
   `--style score` path (so the regression-tested score path is unchanged when
   `poses` is absent). The atoms are written to a temp file via a quoted heredoc
   (`<<'POSE_ATOMS_EOF'`) so apostrophes in atom questions are safe.
3. **Gate on the recomputed fields.** A pose output passes iff
   `anatomy_pass === true && faithfulness >= faithThreshold` (0.8 default,
   overridable via `args.faithThreshold`). `anatomy_pass === false` is a HARD
   fail regardless of faithfulness — a six-fingered hand is not redeemed by a
   correct background.
4. **Per-pose × per-atom regression matrix.** `result.poseMatrix[]` records, per
   pose: `poseId`, `anatomy_pass`, `faithfulness`, `failed_atoms[]`, and
   `atoms:[{id,q,present}]`. Stable atom ids let a caller diff this matrix
   commit-over-commit — a commit that drops dancer's-pose atom `a4` (arm reaches
   back to ankle) from present→absent is caught even if `overall` is unchanged.
   This is the real L2 signal, per the PRD's "comparative ranking beats absolute
   score" rule.
5. **Silent-failure protection carries over.** A `judgePose()` that throws or
   returns null/shapeless becomes `{scored:false, style:"pose_dsg",
   needsReview:true}` — never a dropped null. `judgments` stays one-entry-per-
   output, so "could not validate" can never be mistaken for "validated and
   passed".

To run it on a pose set:

```bash
bun-apps/s2-agent/run.sh -e workflow -p \
  "read bun-apps/s2-agent-ext-flux2/workflows/test-flux2-e2e.js and execute it via the workflow tool (background:false), passing args.poses = the L3+L4 entries of bun-apps/s2-agent-ext-flux2/workflows/poses.json"
```

---

## 6. Sources

Pose / anatomy benchmarks:
- [HumanRefiner / AbHuman (ECCV 2024)](https://arxiv.org/html/2407.06937v1) — 56K images, 147K annotations, 18 anomaly categories; the anatomy gate is derived from this taxonomy.
- [HumanBench (WACV 2026)](https://openaccess.thecvf.com/content/WACV2026/papers/Jain_HumanBench_Two_Heads_No_Legs_But_Mostly_Human_the_State_WACV_2026_paper.pdf)
- [Evaluating & Predicting Distorted Body Parts (arXiv 2503.00811)](https://arxiv.org/html/2503.00811v1)
- [ImagenWorld — real-world failure benchmark](https://blog.comfy.org/p/introducing-imagenworld)

VLM-as-judge / faithfulness metrics:
- [DSG vs PSG-Score vs Soft-TIFA (comparison)](https://medium.com/@shujuanhuang/the-trinity-of-atomic-faithfulness-dsg-psg-and-soft-tifa-3c4557b12c5b)
- [TIFA benchmark](https://tifa-benchmark.github.io/) · [VQAScore (CMU)](https://blog.ml.cmu.edu/2024/10/07/vqascore-evaluating-and-improving-vision-language-generative-models/) · [t2v_metrics code](https://github.com/linzhiqiu/t2v_metrics)
- [Metrics for Compositional T2I (arXiv 2509.21227)](https://arxiv.org/html/2509.21227v1) — DSG best for 3D/pose, VQAScore for 2D.
- [FineGRAIN](https://openreview.net/forum?id=qlZI9Bgxpy) · [Awesome-Evaluation-of-Visual-Generation](https://github.com/ziqihuangg/Awesome-Evaluation-of-Visual-Generation)
- [Best LLM-as-a-Judge practices 2025](https://www.reddit.com/r/AIEval/comments/1q59aaj/best_llmasajudge_practices_from_2025/) — "ditch the 1-10 scale".
