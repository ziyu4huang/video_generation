"""image-workflow — Multi-stage workflow sub-action for 'run.py image workflow'.

Chains: base generation → face detailer → post-processing → upscale
into a single CLI invocation with per-generation subfolder output.

Public API:
  add_workflow_args(parser)  — register workflow-specific CLI arguments
  run_workflow(args)         — execute the full workflow
"""

import os
import sys

from app.commands._shared import resolve_lora_path, resolve_prompt
from app.run_config import RunConfig


PARSER_META = {
    "help": "Multi-stage workflow: generate → face detail → post-process → upscale",
    "description": (
        "Run the full Z-Image workflow pipeline: base generation (T2I or I2I), "
        "optional face detailing, post-processing (film grain, sharpening, LUT, "
        "skin contrast), and upscaling (ESRGAN or SeedVR2). All stage outputs "
        "are saved to a per-generation subfolder."
    ),
}


def add_workflow_args(parser):
    """Register workflow-specific arguments on an argparse parser.

    NOTE: --width, --height, --steps, --seed, --prompt, --input, --denoise-strength,
    --latent-upscale, --draft, --lora-path, --lora-scale, --upscale, --upscale-model,
    --upscale-method, --count are already registered by add_t2i_args() and
    add_common_generation_args(). Only workflow-unique args are registered here.
    """
    # Face detailer
    parser.add_argument("--face-detail", action="store_true", default=False,
                        help="Enable face detailer (mediapipe detect + re-denoise)")
    parser.add_argument("--face-detail-denoise", type=float, default=0.15,
                        help="Face detailer denoise strength (default: 0.15)")
    parser.add_argument("--face-detail-steps", type=int, default=9,
                        help="Face detailer denoising steps (default: 9)")
    parser.add_argument("--face-detail-lora", type=str, default=None,
                        help="Optional LoRA for face detail enhancement")

    # Post-processing
    parser.add_argument("--film-grain", type=float, default=0.0,
                        help="Film grain intensity (0.0–0.03, 0 = off)")
    parser.add_argument("--sharpening", type=float, default=0.0,
                        help="CAS sharpening strength (0.0–1.0, 0 = off)")
    parser.add_argument("--lut", type=str, default=None,
                        help="Path to .cube LUT file for color grading")
    parser.add_argument("--lut-strength", type=float, default=0.3,
                        help="LUT blend strength (0.0–1.0, default: 0.3)")
    parser.add_argument("--skin-contrast", action="store_true", default=False,
                        help="Apply selective skin contrast enhancement (CLAHE)")
    parser.add_argument("--noise-clean", action="store_true", default=False,
                        help="Apply noise/JPEG artifact cleanup")

    # Seed variance
    parser.add_argument("--seed-variance", action="store_true", default=False,
                        help="Enable seed variance enhancer (perturb text embeddings)")
    parser.add_argument("--seed-variance-percent", type=float, default=50.0,
                        help="Percentage of embedding values to perturb (default: 50)")
    parser.add_argument("--seed-variance-strength", type=float, default=20.0,
                        help="Noise scale for seed variance (default: 20)")
    parser.add_argument("--seed-variance-switchover", type=float, default=20.0,
                        help="Use noisy embedding for first N%% of steps (default: 20)")


def run_workflow(args):
    """Execute the full multi-stage workflow. Called by image.py dispatcher."""
    from app.workflow import WorkflowOrchestrator, WorkflowResult

    # Build RunConfig from args
    rc = RunConfig(
        schema_version=RunConfig.__dataclass_fields__["schema_version"].default,
        command="image workflow",
        pipeline="zimage",

        # Prompt
        prompt=resolve_prompt(args) if hasattr(args, "prompt") else None,
        prompt_file=getattr(args, "prompt_file", None),

        # Generation
        width=getattr(args, "width", None) or 640,
        height=getattr(args, "height", None) or 960,
        steps=getattr(args, "steps", 10),
        seed=getattr(args, "seed", 42),
        lora_path=resolve_lora_path(getattr(args, "lora_path", None)),
        lora_scale=getattr(args, "lora_scale", 1.0),

        # I2I
        input_image=getattr(args, "input_image", None),
        latent_upscale=getattr(args, "latent_upscale", 1.0),
        denoise_strength=getattr(args, "denoise_strength", 1.0),

        # Upscale
        upscale=getattr(args, "upscale", False),
        upscale_model=getattr(args, "upscale_model", None),
        upscale_method=getattr(args, "upscale_method", "esrgan"),

        # Seed variance
        seed_variance=getattr(args, "seed_variance", False),
        seed_variance_percent=getattr(args, "seed_variance_percent", 50.0),
        seed_variance_strength=getattr(args, "seed_variance_strength", 20.0),
        seed_variance_switchover=getattr(args, "seed_variance_switchover", 20.0),

        # Workflow-specific fields (stored as extra attrs)
        draft=getattr(args, "draft", False),
    )

    # Inject workflow-specific config as extra attributes
    rc.face_detail = getattr(args, "face_detail", False)
    rc.face_detail_denoise = getattr(args, "face_detail_denoise", 0.15)
    rc.face_detail_steps = getattr(args, "face_detail_steps", 9)
    rc.face_detail_lora = getattr(args, "face_detail_lora", None)

    rc.film_grain = getattr(args, "film_grain", 0.0)
    rc.sharpening = getattr(args, "sharpening", 0.0)
    rc.lut_path = getattr(args, "lut", None)
    rc.lut_strength = getattr(args, "lut_strength", 0.3)
    rc.skin_contrast = getattr(args, "skin_contrast", False)
    rc.noise_clean = getattr(args, "noise_clean", False)

    # Draft mode overrides
    if rc.draft:
        rc.steps = 4
        rc.width = 512
        rc.height = 512
        print("  [Draft] Quick preview: 4 steps, 512x512")

    # Execute workflow
    orchestrator = WorkflowOrchestrator(rc)
    try:
        result = orchestrator.execute()

        # Save all outputs to subfolder
        out_dir = WorkflowOrchestrator.save_outputs(result, rc)
        print(f"\nWorkflow output: {out_dir}")
        print(f"Final image: {os.path.join(out_dir, 'final.png')}")

    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
