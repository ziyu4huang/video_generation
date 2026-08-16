/**
 * registry.ts — explicit tool/provider registry + provider-menu rollup.
 *
 * OpenMontage auto-discovers Python tools via `pkgutil.walk_packages`. The Bun
 * version is an EXPLICIT registry (no filesystem walk) — each provider is
 * declared once, mapping its capability to the native director / cloud API /
 * ffmpeg path that backs it. This is iteration 1's static rollup; later
 * iterations add the actual execution bridges (subprocess to swift directors,
 * `fetch` to cloud APIs, `ffmpeg` shell).
 *
 * The 3-layer architecture (Layer 1 tools / Layer 2 skills / Layer 3 vendor
 * knowledge) maps to: this registry (L1) → MD skills under data/skills (L2,
 * kept as files) → vendor packs (L3, kept as files).
 */

export type Capability =
  | "image_generation"
  | "video_generation"
  | "tts"
  | "music_generation"
  | "video_post"
  | "audio_processing"
  | "analysis"
  | "enhancement"
  | "subtitle"
  | "composition"
  | "story_generation";

export type ProviderBackend = "native_swift" | "cloud_http" | "ffmpeg" | "macos_native";

export interface ProviderEntry {
  /** Tool name (matches OpenMontage's selector namespace where useful). */
  name: string;
  capability: Capability;
  provider: string;
  backend: ProviderBackend;
  /** How the Bun layer will invoke it (iteration 2+ wires these). */
  invoke:
    | "swift:krea2"
    | "swift:flux2"
    | "swift:ltx"
    | "mlx:runpy"
    | "mlx:runpy-image"
    | "mlx:runpy-story"
    | "bun:lmstudio-story"
    | "mlx:runpy-tts"
    | "bun:tts-native"
    | "mlx:runpy-music"
    | "bun:musicgen-native"
    | "bun:kokoro-tts"
    | "bun:twosubject-native"
    | "bun:profile-native"
    | "bun:character-native"
    | "bun:storyboard-native"
    | "mlx:caption"
    | "mlx:controlnet-hybrid"
    | "mlx:workflow-hybrid"
    | "mlx:purify-hybrid"
    | "fetch"
    | "ffmpeg"
    | "macos:vision"
    | "macos:screencapturekit"
    | "macos:say"
    | "bun:builtin"
    | "bun:whisper"
    | "bun:clip"
    | "compose:remotion"
    | "compose:motion"
    | "compose:hyperframes";
  configured: boolean;
  notes?: string;
  /**
   * The director subcommands this provider owns (e.g. "transcribe",
   * "video_understand"). When a caller addresses a tool by {capability, command}
   * (the documented shape), the selector uses this to break capability ties — a
   * command match outranks backend-rank/declaration-order. Leave unset for
   * capabilities whose commands all run on the SAME provider (e.g. image_generation's
   * t2i/i2i/etc.); setting it there would needlessly constrain free-form commands.
   */
  commands?: string[];
  /**
   * When true, this entry is excluded from selectProvider's backend-rank
   * bare-fallback (the final tier when neither an explicit `provider` hint
   * nor a `commands[]` match applies) — only reachable via an explicit
   * `provider` hint or a `commands[]` match. Lets a genuinely-better native
   * provider ship without silently becoming every existing bare caller's new
   * default (see selector.ts's header comment and kokoro_tts's notes for the
   * concrete case this was added for).
   */
  optIn?: boolean;
}

/**
 * The iteration-1 provider set. Native directors that already exist are marked
 * `configured: true` (the binary may still need building, but the path exists);
 * cloud/ffmpeg/macos bridges are marked configured by whether their env/CLI is
 * present at preflight time (refined in later iterations).
 */
export const REGISTRY: ProviderEntry[] = [
  // Image generation — native Swift/MLX directors. Both declare an explicit
  // `commands` list so {capability, command} routing is unambiguous instead of
  // relying on the backend-rank/declaration-order default tiebreak (which would
  // otherwise always pick krea2, the first-declared entry, for ANY command
  // neither director explicitly claims — e.g. flux2's own "scene"/"edit"/
  // "upscale"/etc. previously required an explicit provider:"flux2" hint to
  // reach at all). "anime2real"/"expansion" are legacy run.py action-name
  // ALIASES kept routable here (2026-07-13 migration off runpy_image, see
  // below) — bridge.ts's realFlux2 normalizes them onto flux2's real "style"/
  // "expand" commands + field names before calling runFlux2.
  {
    name: "krea2_image",
    capability: "image_generation",
    provider: "krea2",
    backend: "native_swift",
    invoke: "swift:krea2",
    configured: true,
    commands: ["t2i", "i2i", "restore"],
    notes: "swift/krea2-image-director (Z-Image/Krea2 T2I + ControlNet + style transfer). restore routes here as an alias of i2i (2026-07-13 migration): image-restore.py is a thin wrapper forcing reference_image=None onto i2i with no other overrides — krea2's native i2i has no ControlNet concept at all (pure SDEdit: input+prompt+strength), so restore==i2i exactly. bridge.ts's normalizeLegacyImageRequest renames the command to i2i before calling runKrea2.",
  },
  {
    name: "flux2_image",
    capability: "image_generation",
    provider: "flux2",
    backend: "native_swift",
    invoke: "swift:flux2",
    configured: true,
    commands: [
      "t2i", "scene", "edit", "style", "kv-style-transfer", "angle", "swap",
      "expand", "upscale", "gate", "segment", "story", "inpaint", "faceswap",
      "kontext", "styletransfer", "cutout",
      "anime2real", "expansion", // legacy run.py aliases — see notes above
    ],
    notes: "swift/flux2-image-director (Flux2 Klein T2I/i2i/edit/scene/angle/swap/expand/style/upscale/inpaint/faceswap). anime2real routes here as an alias of `style --preset anime2real`; expansion routes here as an alias of `expand` (bridge.ts normalizes both). `inpaint` moved here (2026-07-13, session 5) from runpy_image — flux2's InpaintCommand.swift ports image-inpaint.py's production masked-redraw path onto the ALREADY-SHIPPED Flux2EditPipeline.inpaint (same latent-mask re-injection machinery used by SwapCommand's `--inpaint` seamless mode, just fed a user-supplied mask PNG via the existing Flux2ImageLoad.loadMaskAsChannel instead of a SAM3-derived one — no new denoise-loop/composite code needed). Deferred (documented, not silently dropped): the Python's `--crop`/`--crop-margin` Union 2.1 crop-for-detail mode (crop mask bbox + margin, inpaint at higher effective resolution, paste back) — out of scope for this port, full-frame inpaint at `--longest` covers the common case. `faceswap` moved here (2026-07-13, session 4) from runpy_image — image-faceswap.py's real-usage path (--input/--face, no --self-test) is genuine Flux2 Klein transformer compute Swift already had every primitive for: FaceSwapCommand.swift combines Flux2EditPipeline's multi-ref conditioning (same mechanism `edit`/`style` use) with the BFS LoRA fused at init time via Flux2LoRALoaderCLI (same mechanism `style`/`scene` use) — the two were exercised separately before but never wired together for this. bridge.ts's normalizeLegacyImageRequest maps the legacy input/face field names onto FaceSwapCommand's body/face. DEFERRED to Python (documented, not silently dropped — see runpy_image if a caller still needs it): --self-test's 3-phase source synthesis (ZImage body + Flux2 T2I face) and its optional VLM quality scoring + HTML review — pure test/QA scaffolding, not the swap mechanism itself, and the real-usage command never touches them. `kontext` moved here (2026-07-29) from runpy_image — the 2026-07-14 kontext epic already numerically verified KontextTransformer/CLIP/T5/VAE; this port adds the missing denoise loop (KontextPipeline.swift) + CLI (KontextCommand.swift), see .planning/plans/2026-07-29-kontext-swift-native-port.md. `storyboard --kontext-lock` moved OFF runpy_image too (2026-08-01) — see storyboard_native's notes below; it now routes recurring-character shots through this same `kontext` command, one call per shot. `styletransfer` moved here (2026-07-30) from runpy_image — image-styletransfer.py's core mechanism (Flux2 Klein SDEdit img2img: content image as init canvas, style prompt repaints it, `--strength` controls the balance) already existed natively as Flux2EditPipeline.generate's initImagePath/denoiseStrength params (already wired by InpaintCommand/SceneCommand); this port is a new CLI file (StyleTransferCommand.swift) wiring that existing capability, no new pipeline code. DEFERRED to Python (documented, not silently dropped — see runpy_image if a caller still needs it): `--playbook` style-source support (OM playbook YAML → image_prompt_prefix/consistency_anchors/aesthetic) — no playbook YAML parser exists anywhere in Swift/TS yet, see .planning/specs/2026-07-30-styletransfer-swift-native-port-design.md. `cutout` moved here (2026-07-31) from runpy_image — image-cutout.py's SAM3 segmentation step already had a working Python-subprocess bridge (sam3_segment_bridge.py) that flux2's own `segment` command already calls; this port keeps that bridge unchanged and adds the missing downstream piece, Swift-native alpha compositing (new ImageSave.savePNGRGBA + CutoutCommand.swift) — no SAM3 port, no new pipeline/model code. DEFERRED to Python (documented, not silently dropped — see runpy_image if a caller still needs it): `--feather`/`--fill-holes` configurability (the bridge has a fixed feather radius of 10 and never fills interior holes), see .planning/specs/2026-07-31-cutout-swift-native-port-design.md. `character_native.ts` was wired to call this command (2026-08-01, see that entry's notes below and .planning/specs/2026-08-01-character-native-cutout-wiring-design.md) — its `views[].cutout` now carries a real alpha-composited path (still `null` when SAM3 finds no detection) instead of always being `null`.",
  },
  { name: "z_image", capability: "image_generation", provider: "z-image", backend: "native_swift", invoke: "swift:krea2", configured: true, notes: "Z-Image T2I (via krea2 director family)" },
  // run.py image adapter — the force multiplier for the LONG TAIL of image
  // sub-actions that have no Swift-native equivalent yet (controlnet/faceswap/
  // profile/purify/restore/multicouple/twosubject/workflow/inpaint/character/
  // kontext) — most of that list has itself since moved off this adapter too
  // (see each command's own "moved OFF" note below); purify/multicouple are
  // the only ones still actually here. angle/swap/anime2real/expansion/i2i moved OFF this
  // adapter (2026-07-13) onto flux2/krea2 above, once confirmed those Swift
  // directors already implement the same mechanism (Flux2Klein multi-ref /
  // outpaint / style-preset / SAM3-swap / krea2 SDEdit-i2i) — see
  // output/next-goal-20260713_*.md for the audit. Declared AFTER the Swift
  // directors (same native_swift rank 0) and addressed by COMMAND (commands[]
  // below), so the selector routes {image_generation, "controlnet"|"faceswap"|
  // ...} here when no Swift director claims that command.
  // probeConfigured = runPyRuntimePresent (venv python + run.py). LOCAL MLX only.
  {
    name: "runpy_image",
    capability: "image_generation",
    provider: "runpy-image",
    backend: "native_swift",
    invoke: "mlx:runpy-image",
    configured: true,
    commands: ["multicouple"],
    notes: "run.py image adapter (src/runpy_image.ts) — the remaining local run.py image sub-actions with no Swift-native equivalent. Command-routed: a {capability, command} where command is multicouple reaches run.py. storyboard moved OFF this adapter (2026-08-01) onto storyboard_native below — see that entry's notes; image-storyboard.py's own docstring calls its generation \"no new MLX generation code,\" reusing the same execute_generation core t2i uses. cutout/styletransfer were present in runpy_image.ts's ImageAction/CLI mapping but missing from this commands[] list (a pre-existing registry gap, fixed 2026-07-13) — they were unreachable via the selector despite being implemented. Basic t2i/i2i and angle/swap/anime2real/expansion now stay on the Swift directors (see flux2_image/krea2_image above). `twosubject` moved OFF this adapter (2026-07-13) onto twosubject_native below — see that entry's notes; `multicouple` stays here PERMANENTLY (genuine MLX/GPU latent-couple compute, unportable — see twosubject_native.ts's module doc). `restore` moved OFF this adapter (2026-07-13, session 3) onto krea2_image above as an i2i alias — image-restore.py is a thin wrapper with no genuine MLX-only logic. `profile` moved OFF this adapter (2026-07-13, session 4) onto profile_native below — see that entry's notes; image-profile.py's own comments confirm it reuses the angle mechanism, already Swift-native. `controlnet` moved OFF this adapter (2026-07-13, session 3) onto controlnet_hybrid below — see that entry's notes for the style-forked (caption.ts-style) native/python split. `inpaint` moved OFF this adapter (2026-07-13, session 5) onto flux2_image above — see that entry's notes; image-inpaint.py's core masked-redraw mechanism was already Swift-native (Flux2EditPipeline.inpaint), just missing a CLI command exposing it for an external mask. `character` moved OFF this adapter (2026-07-13, session 6) onto character_native below — see that entry's notes; image-character.py's own header calls itself pure orchestration composing already-certified `profile` + `cutout` primitives, both already Swift-native (profile_native.ts + flux2's `cutout`). `faceswap` moved OFF this adapter (2026-07-13, session 4) onto flux2_image above — see that entry's notes; the real-usage BFS swap mechanism is now Swift-native (FaceSwapCommand.swift), only --self-test's source-synthesis/VLM-scoring/HTML-review scaffolding stays Python-only (and has no registry route — it was never itself a distinct {capability,command} routing target). `purify` moved OFF this adapter (2026-08-05) onto purify_hybrid below — see that entry's notes; only the `--backend transformer` redraw path moved (a thin wrapper around flux2's already-native `styletransfer` command), `--backend seedvr2` (the default) and `--remove` stay here unchanged. `workflow` moved OFF this adapter (2026-07-14, session 7) onto workflow_hybrid below — see that entry's notes; a genuinely portable SUBSET (base-gen + flux2 face-detail + flux2 postprocess + ESRGAN-upscale) is native as of 2026-08-03, only LUT color-grading/seedvr2-upscale still fall back here. `kontext` moved OFF this adapter (2026-07-29) onto flux2_image above — see that entry's notes; the 2026-07-14 kontext epic already numerically verified KontextTransformer/CLIP/T5/VAE, this port adds the missing denoise loop + CLI. `styletransfer` moved OFF this adapter (2026-07-30) onto flux2_image above — see that entry's notes; the SDEdit img2img mechanism it needs was already Swift-native (Flux2EditPipeline.generate's initImagePath/denoiseStrength), just missing a CLI command exposing it without identity refs. `--playbook` style-source support stays here (no Swift/TS playbook YAML parser exists yet) — NOTE: command-routing now sends ALL `styletransfer` traffic to flux2_image by default (commands[] moved wholesale, not style-forked like controlnet_hybrid/workflow_hybrid above), so a `--playbook` caller must pass an explicit `provider: \"runpy-image\"` hint to reach this adapter; there is no request-shape-based fallback for it. `cutout` moved OFF this adapter (2026-07-31) onto flux2_image above — see that entry's notes; SAM3 segmentation itself stays on the same Python-subprocess bridge flux2's own `segment` command already uses (not ported), the new Swift code is purely the downstream alpha compositing. Local MLX, never a cloud GAI API.",
  },
  // controlnet — 2026-07-13 session 3: swift/krea2-image-director ships a
  // REAL native Swift ControlNet (Krea2ControlNet.swift, Control-LoRA
  // mechanism), but it is NOT a drop-in replacement for image-controlnet.py's
  // canny/scribble ControlNet: the Swift command does zero preprocessing of
  // its own (the control image must already be a depth/pose/edge map — see
  // its --control-image help text "preprocessed externally") and requires a
  // separately-downloaded depth Control LoRA (Patil/Krea-2-depth-controlnet).
  // The Python path has built-in canny/scribble/raw preprocessing (cv2, no
  // extra model) plus blur/outline-removal knobs the Swift path cannot do at
  // all. Rather than silently reroute existing canny/scribble callers onto an
  // incompatible native command (which would break at runtime demanding a
  // control-lora + a precomputed control image), this stays under ONE command
  // name ("controlnet") and forks by request shape inside bridge.ts's
  // realControlNet — the same style-fork caption.ts uses for its 4 native
  // styles vs the other 10 that stay on run.py. Native path only fires when
  // the caller supplies the native `controlImage` field AND none of the
  // Python-only preprocessing knobs (controlnetType canny/scribble/pose/hed,
  // blurRef, removeOutlines, controlnetAbTest) — see
  // isNativeControlNetRequest in bridge.ts. Everything else still reaches
  // run.py's controlnet action via realRunPyImage exactly as before.
  {
    name: "controlnet_hybrid",
    capability: "image_generation",
    provider: "controlnet-hybrid",
    backend: "native_swift",
    invoke: "mlx:controlnet-hybrid",
    configured: true,
    commands: ["controlnet"],
    notes: "Style-forked (caption.ts pattern) controlnet dispatch (src/bridge.ts realControlNet). Native path: swift/krea2-image-director's Krea2ControlNet.swift (Control LoRA + Krea 2 Turbo) — fires only when the caller supplies an already-preprocessed `controlImage` and no Python-only preprocessing knob. Fallback path: run.py's image-controlnet.py (canny/scribble/raw preprocessing, Z-Image/Flux2-Klein) — fires for everything else, unchanged from before this migration. See isNativeControlNetRequest for the exact split.",
  },
  // workflow — 2026-07-14 (session 7): image-workflow.py chains 4 stages (base
  // gen → face detailer → post-process → upscale). Full-file investigation
  // (workflow_native.ts's module doc has the line-numbered citations) found
  // only a SUBSET is genuinely portable: stage 1 (base T2I/I2I) is already
  // Swift-native (krea2 t2i/i2i, the zimage pipeline run_workflow hardcodes),
  // and stage 4's DEFAULT method (esrgan) is already Swift-native too (flux2
  // `upscale`, RealPLKSR — same model the standalone `upscale_flux2` entry
  // above uses). Stage 2 (face detailer) is now native too (2026-08-02):
  // FaceDetector.swift (Apple Vision VNDetectFaceRectanglesRequest) replaces
  // mediapipe's TFLite detector, and FaceDetailPipeline.swift replicates the
  // crop/regenerate/composite loop via the existing Flux2EditPipeline/
  // Flux2Composite primitives — exposed as `flux2 face-detail`. Stage 3
  // (post-process: film grain/CAS+unsharp sharpening/bilateral noise-clean/
  // CLAHE skin-contrast) is now native too (2026-08-03): PostProcessFilters.
  // swift reimplements all 4 as pure MLXArray algorithms operating directly
  // on the (1,3,H,W) buffer the pipeline already carries — the earlier
  // "needs a decoded RGB buffer / image-codec dependency" blocker assumed a
  // PIL/numpy-style byte buffer had to be decoded via an external library
  // first, which turned out not to be true — exposed as `flux2 postprocess`.
  // Only LUT color-grading stays non-portable (zero `.cube` assets or
  // callers exist anywhere in this repo — a theoretical GUI field, not a
  // real gap; see .planning/specs/2026-08-03-postprocess-swift-native-port-
  // design.md). Stage 4's `seedvr2` method stays confirmed PyTorch/torch-
  // MPS-only (no MLX/Swift port anywhere — see memory
  // project_pytorch_mps_versions/project_attention_backends_mps).
  // So this stays under ONE command name ("workflow") and forks by request
  // shape inside bridge.ts's realWorkflow — the same style-fork controlnet_
  // hybrid (above) and caption.ts use. Native path only fires when NONE of
  // lut/lutPath/lut_path is requested and upscale_method isn't "seedvr2" —
  // see isNativeWorkflowRequest in bridge.ts. Everything else still reaches
  // run.py's image-workflow.py via realRunPyImage exactly as before.
  {
    name: "workflow_hybrid",
    capability: "image_generation",
    provider: "workflow-hybrid",
    backend: "native_swift",
    invoke: "mlx:workflow-hybrid",
    configured: true,
    commands: ["workflow"],
    notes: "Style-forked (caption.ts/controlnet_hybrid pattern) workflow dispatch (src/bridge.ts realWorkflow). Native path: src/workflow_native.ts orchestrating krea2 t2i/i2i (base gen) optionally chained with flux2 face-detail (Apple Vision detect + SDEdit regen), flux2 postprocess (film-grain/CAS+unsharp-sharpening/bilateral-noise-clean/CLAHE-skin-contrast, 2026-08-03 — see PostProcessFilters.swift), and/or flux2 upscale (ESRGAN/RealPLKSR) — fires whenever the request needs neither LUT color-grading nor upscale_method=seedvr2. Fallback path: run.py's image-workflow.py (full 4-stage pipeline incl. LUT grading, SeedVR2) — fires for everything else, unchanged from before this migration. See isNativeWorkflowRequest for the exact split and workflow_native.ts's module doc for the full per-stage portability investigation.",
  },
  // purify — 2026-08-05: image-purify.py's `--backend transformer` redraw
  // path (`_run_transformer_backend`) is pure parameter computation (a
  // mode→denoise lookup table + a resolution-string parser) around a
  // flux2-klein SDEdit img2img call — already Swift-native as
  // `swift/flux2-image-director`'s `styletransfer` command
  // (Flux2EditPipeline.generate's initImagePath/denoiseStrength, no new
  // Swift code). `--backend seedvr2` (the default) stays confirmed
  // PyTorch/torch-MPS-only. `--remove` (subtitle/watermark/screen-ui
  // removal via SAM3 + inpaint + feathered composite) is a separate,
  // larger new-algorithm effort with no existing Swift primitive for its
  // mask-union/dilate/median-fill/composite steps — deferred, not silently
  // dropped, see .planning/specs/2026-08-05-purify-transformer-backend-
  // swift-native-port-design.md. So this stays under ONE command name
  // ("purify") and forks by request shape inside bridge.ts's realPurify —
  // the same style-fork controlnet_hybrid/workflow_hybrid (above) use.
  // Native path only fires when backend==="transformer", no `remove` is
  // requested, and the input is a `.png` — see isNativePurifyRequest in
  // bridge.ts. Everything else still reaches run.py's image-purify.py via
  // realRunPyImage exactly as before.
  {
    name: "purify_hybrid",
    capability: "image_generation",
    provider: "purify-hybrid",
    backend: "native_swift",
    invoke: "mlx:purify-hybrid",
    configured: true,
    commands: ["purify"],
    notes: "Style-forked (caption.ts/controlnet_hybrid/workflow_hybrid pattern) purify dispatch (src/bridge.ts realPurify). Native path: src/purify_native.ts computing denoise/dimensions/output-path then delegating to flux2's native `styletransfer` command — fires only for `--backend transformer` requests with a `.png` input and no `--remove`. Fallback path: run.py's image-purify.py (the default `--backend seedvr2` SeedVR2 redraw/upscale, and `--remove` subtitle/watermark/screen-ui removal) — fires for everything else, unchanged from before this migration. See isNativePurifyRequest for the exact split and purify_native.ts's module doc for the parameter-math parity notes.",
  },
  // twosubject — 2026-07-13: image-twosubject.py is PURE CONTROL FLOW (VLM
  // prompt-master + best-of-N native t2i + VLM judge, optional VLM revise) —
  // no MLX compute of its own (the actual pixels come from Z-Image t2i, the
  // VLM calls are bare LM Studio HTTP), so it moved off run.py onto a direct
  // Bun implementation (twosubject_native.ts) calling krea2's native t2i +
  // lmstudio.ts's vision-call primitive. Declared BEFORE runpy_image is
  // irrelevant here since `twosubject` was removed from runpy_image's
  // commands[] above — no overlap, no selector tiebreak needed. Do NOT
  // confuse with `multicouple` (image-multicouple.py), which is genuine
  // latent-couple MLX/GPU compute and stays on runpy_image permanently.
  {
    name: "twosubject_native",
    capability: "image_generation",
    provider: "twosubject-native",
    backend: "native_swift",
    invoke: "bun:twosubject-native",
    configured: true,
    commands: ["twosubject"],
    notes: "Direct Bun implementation (src/twosubject_native.ts) of the VLM-driven single-prompt two-subject loop: VLM prompt-master composes one anti-bleeding two-subject prompt → best-of-N seeds via krea2 native Z-Image t2i → VLM judges every seed on the two-subject rubric → optional VLM revise-and-regenerate round if the best score is below --min-overall. No run.py, no MLX venv for the control flow — t2i pixels still come from local krea2/Z-Image (native Swift), VLM calls are local LM Studio HTTP. Known deltas from the Python: (1) no --cfg-scale forwarding (krea2's native t2i has no cfg-scale flag yet — a real quality delta from the Python's cfg_scale=3.0 default); (2) pick_best has no bg_edge_split pixel tiebreak (no image-decode lib in this package); (3) ref-image captioning uses a minimal inline i2t prompt, not the full 14-style caption.py/caption.ts port.",
  },

  // profile — 2026-07-13 (session 4): image-profile.py's own header comments
  // say it deliberately reuses the SAME mechanism `image-angle.py` uses
  // (short "angle-style" prompts driving Flux2KleinEdit multi-ref) — a
  // command already fully Swift-native (flux2_image's `angle`, above). So
  // profile moved off run.py onto a direct Bun implementation
  // (profile_native.ts) that calls `angle` once per requested view
  // (front/back/side) instead of shelling out to run.py. Declared AFTER
  // runpy_image is irrelevant here since `profile` was removed from
  // runpy_image's commands[] above — no overlap, no selector tiebreak needed.
  {
    name: "profile_native",
    capability: "image_generation",
    provider: "profile-native",
    backend: "native_swift",
    invoke: "bun:profile-native",
    configured: true,
    commands: ["profile"],
    notes: "Direct Bun implementation (src/profile_native.ts) of image-profile.py's CORE multi-view character-sheet generation: for each requested view in front/back/side (canonical front→side→back order), calls flux2's native `angle` command once with the same reference image (view→angle-preset: front→front, back→back, side→right — 'side' is a documented deliberate choice since the Python source itself never disambiguates left/right for that view). No run.py, no MLX venv — pixels come from flux2-klein's native Flux2KleinEdit multi-ref pipeline (the exact mechanism image-profile.py's own comments say it reuses). Requires --input (v1 only ports the flux2-klein reference-conditioned path; the Python's no-input zimage-text-only fallback is a genuinely different pipeline, out of scope). Deferred (documented, not silently dropped — see profile_native.ts's module doc): --prompt-style detailed / --base-prompt / --vlm auto-caption (only affect the non-default 'detailed' style; the default 'angle' style this module always uses never consults them), --chain-ref (angle's single-image `input` field can't express a cascading second reference), --ref-strength (Python ignores it for flux2-klein unconditionally, and angle has no equivalent flag), VLM angle/identity verification, the HTML viewer, and the horizontal strip PNG (both need an image-codec dependency this package doesn't have).",
  },

  // character — 2026-07-13 (session 6): image-character.py's own header says
  // it plainly — "PIPELINE ... composes the certified primitives — zero new
  // MLX generation code": Phase 1 is `image profile` multi-view generation
  // (already Swift-native, profile_native.ts above), Phase 2 is Step-1
  // `cutout` (SAM3 segment + alpha compositing per view, already
  // Swift-native, flux2's `cutout` command as of 2026-08-01 — originally
  // `segment`, mask-only), Phase 3 is a pure IdentitySpec.json builder (no
  // model calls at all). So character moved off run.py onto a direct Bun
  // implementation (character_native.ts) orchestrating profile_native.ts +
  // flux2 `cutout` + a pure spec builder. Declared AFTER runpy_image is
  // irrelevant here since `character` was removed from runpy_image's
  // commands[] above — no overlap, no selector tiebreak needed.
  {
    name: "character_native",
    capability: "image_generation",
    provider: "character-native",
    backend: "native_swift",
    invoke: "bun:character-native",
    configured: true,
    commands: ["character"],
    notes: "Direct Bun implementation (src/character_native.ts) of image-character.py's 3-phase character-sheet build: Phase 1 delegates straight to runProfileNative (profile_native.ts, above) for the multi-view sheet; Phase 2 calls flux2's native `cutout` command (SAM3.1 bridge + MLX alpha compositing) once per generated view; Phase 3 assembles + can write IdentitySpec.json (schema character-lock.v1). `views[].cutout` carries a real alpha-composited PNG path, or `null` when SAM3 found no detection for that view — Phase 2 moved off `segment` onto `cutout` (2026-08-01, see .planning/specs/2026-08-01-character-native-cutout-wiring-design.md and the flux2_image entry's notes above), closing the mask-only gap this module used to document here. Also deferred: Python's `_fill_holes` interior-hole fill (the SAM3 bridge `cutout` calls through has a fixed feather-only behavior, unchanged by the 2026-07-31/2026-08-01 ports) and `--self-test` hero synthesis (needs the MLX ZImagePipeline, Python-only). No run.py, no MLX venv for the orchestration itself — segmentation still bridges through Python via flux2's own `cutout` command (unchanged, pre-existing Swift-native path — the same SAM3 bridge `segment` uses for every other flux2 caller).",
  },

  // storyboard — 2026-08-01: image-storyboard.py's own docstring says its
  // generation "reuses the tested execute_generation core (the same path
  // t2i uses) — no new MLX generation code": scene decomposition is a plain
  // LM Studio HTTP call (same shape story_native.ts already ported), scene
  // planning is pure logic, and per-shot generation routes onto already-
  // Swift-native primitives (krea2 t2i / flux2 edit / flux2 kontext). So it
  // moved off run.py onto a direct Bun implementation (storyboard_native.ts)
  // — see .planning/specs/2026-08-01-storyboard-native-port-design.md.
  // Declared AFTER runpy_image is irrelevant here since `storyboard` was
  // removed from runpy_image's commands[] above — no overlap, no selector
  // tiebreak needed.
  {
    name: "storyboard_native",
    capability: "image_generation",
    provider: "storyboard-native",
    backend: "native_swift",
    invoke: "bun:storyboard-native",
    configured: true,
    commands: ["storyboard"],
    notes: "Direct Bun implementation (src/storyboard_native.ts) of image-storyboard.py's core generation line: scene decomposition (LM Studio HTTP, same gemma-brain pattern as story_native.ts) → scene_spec/shot_prompt_builder planning (ported 1:1, pure logic) → per-shot routing onto krea2 t2i (independent) / flux2 edit (locked, hero as sole multi-ref — no denoise-strength knob, a documented delta from Python's SDEdit soft-lock) / flux2 kontext (kontext-lock, one call per shot — no batched single-model-load like Python's arc-level Kontext batching) → ffmpeg-tiled contact sheet. No run.py, no MLX venv for the orchestration itself — generation still bridges through the same krea2/flux2 Swift directors every other native module uses. Deferred to runpy_image (documented, not silently dropped): the --judge closed loop (caption score + VLM identity verification + weak-frame regeneration), see .planning/specs/2026-08-01-storyboard-native-port-design.md.",
  },

  // story adapters — OM's research→proposal→approval stage UPSTREAM of
  // `image storyboard`. From a topic the local gemma brain emits angles + an
  // OM-shaped proposal_packet; `story shots` delegates the approved concept to
  // `image storyboard`. Closes the OM storyline gap.
  //
  // 2026-07-13: angles/propose are PURE LM Studio HTTP calls underneath (no MLX
  // compute in the Python at all — `app/commands/story.py`'s `_gemma_json_call`
  // is a bare `requests.post`), so they moved onto a direct Bun `fetch` client
  // (lmstudio.ts / story_native.ts) — no Python subprocess, no MLX venv needed.
  // shots stays on runpy_story below: `story shots` itself still shells out
  // to Python's `run_shots()`, which spawns its OWN second, entirely-Python
  // `run.py image storyboard` subprocess — it never reaches storyboard_native
  // below (2026-08-01). Only a caller that bypasses runpy_story and invokes
  // {image_generation, "storyboard"} directly lands on that Bun-native path.
  {
    name: "story_native",
    capability: "story_generation",
    provider: "lmstudio-story",
    backend: "native_swift",
    invoke: "bun:lmstudio-story",
    configured: true,
    commands: ["angles", "propose"],
    notes: "Direct LM Studio client (src/story_native.ts) — angles → N differentiated creative angles; propose → an OM-shaped proposal_packet (concept options with scene_list/visual_language/est_shot_count). Brain = local gemma. No run.py, no MLX venv — pure Bun fetch against the local LM Studio server. Writes the same <base>_angles.json/_proposal.yaml artifact shape run.py used to, so `story shots` (below) still reads it unchanged.",
  },
  {
    name: "runpy_story",
    capability: "story_generation",
    provider: "runpy-story",
    backend: "native_swift",
    invoke: "mlx:runpy-story",
    configured: true,
    commands: ["shots"],
    notes: "run.py story adapter (src/runpy_story.ts) — shots: folds an approved proposal concept into a narrative + style hint and delegates to the existing `image storyboard` path (subprocess → certified decompose→generate). angles/propose moved to story_native above (2026-07-13). Brain = local gemma (reasoning_effort:none). Local MLX + local LLM, never cloud.",
  },

  // Video generation — native Swift/MLX director.
  { name: "ltx_video", capability: "video_generation", provider: "ltx", backend: "native_swift", invoke: "swift:ltx", configured: true, notes: "swift/ltx-video-director (LTX-2.3 T2V/i2v/relay/upscale). probeConfigured checks the built binary; when unbuilt, mlx:runpy below wins." },
  // run.py video adapter (Option A) — the canonical PYTHON generation runtime
  // (CLAUDE.md: run.py is the only generation runtime). Reaches the SAME run.py
  // call site the Swift `i2v` command bridges via RunPyBridge.swift, with ZERO
  // swift build cost. Ranked below swift:ltx only because it is declared second
  // (both are native_swift rank 0 — presence of the swift binary is the tiebreak,
  // enforced by probeConfigured). LOCAL MLX: never a cloud GAI API.
  { name: "ltx_video_runpy", capability: "video_generation", provider: "ltx-runpy", backend: "native_swift", invoke: "mlx:runpy", configured: true, notes: "run.py video t2i2v adapter (pi-agent-ext-ltx/src/runpy.ts) — local MLX, zero swift build. Wins video_generation when the swift:ltx binary is absent; otherwise the selector prefers swift:ltx." },

  // Composition runtimes.
  { name: "compose_remotion", capability: "composition", provider: "remotion", backend: "native_swift", invoke: "compose:remotion", configured: true, notes: "Remotion Node subprocess (src/remotion.ts) — the ONLY templated composer (layered section_title overlays, crossfade, per-cut animation). Binary resolves REMOTION_BIN → PATH → the bundled <EXT_ROOT>/remotion install (run `bun install` in remotion/ + `remotion browser ensure`); probeConfigured reflects that, so the composition rollup advertises remotion truthfully. compose_motion drops edit.overlays — use this runtime when overlays/layered text are required" },
  { name: "compose_motion", capability: "composition", provider: "motion", backend: "ffmpeg", invoke: "compose:motion", configured: true, notes: "ffmpeg motion compositor (src/compose_motion.ts, Item J) — per-cut ken-burns/zoom/pan via zoompan + xfade crossfade; callable wherever ffmpeg+zoompan+xfade resolve (no browser/swift)" },
  { name: "compose_hyperframes", capability: "composition", provider: "hyperframes", backend: "native_swift", invoke: "compose:hyperframes", configured: true, notes: "HyperFrames CLI subprocess (src/hyperframes_native.ts) — a THIRD templated composer: generates a GSAP-driven HTML composition per render (ken-burns/zoom/pan cuts, section_title overlays, fade-at-boundary transitions), rendered headlessly via the vendor CLI's bundled Puppeteer+Chrome. Binary resolves HYPERFRAMES_BIN → `hyperframes` on PATH → `bunx hyperframes` (the vendor's own supported invocation, unlike remotion's bunx fallback). v1 does not wire edit.audio (narration/music) — use compose_remotion when audio is required. The former GAP note (\"no headless CLI\") was stale — hyperframes@0.7.100 ships a real render CLI; verified end-to-end (2026-08-08) against a real multi-cut+overlay edit_decisions." },
  { name: "compose_ffmpeg", capability: "composition", provider: "ffmpeg", backend: "ffmpeg", invoke: "ffmpeg", configured: true, notes: "concat/trim/subtitle-burn via ffmpeg" },

  // TTS — cloud HTTP (iteration 3) + local fallback.
  { name: "elevenlabs_tts", capability: "tts", provider: "elevenlabs", backend: "cloud_http", invoke: "fetch", configured: false, notes: "needs ELEVENLABS_API_KEY" },
  { name: "openai_tts", capability: "tts", provider: "openai", backend: "cloud_http", invoke: "fetch", configured: false, notes: "needs OPENAI_API_KEY" },
  { name: "piper_tts", capability: "tts", provider: "piper", backend: "native_swift", invoke: "bun:builtin", configured: false, notes: "local Piper binary OR AVSpeechSynthesizer fallback (gap)" },
  // backend: "cloud_http" (NOT native_swift) is deliberate even though the invoke
  // is a local (Bun-process) call: edge-tts's actual synthesis call goes out to
  // Microsoft's service, and probeConfigured's default case (bun:tts-native
  // falls through to it) only reflects registry.configured — it cannot detect
  // "no network" the way fetch's CLOUD_KEY_FOR check detects "no API key".
  // Ranking it in the cloud_http tier (below macos_native) keeps say_tts the
  // SAFE, offline-honest STATIC default. But selectAndGenerate (bridge.ts)
  // opportunistically tries edge-tts FIRST at runtime whenever the static pick
  // landed on say and no explicit provider hint was given, falling back to the
  // say result only on an actual network failure — a 2026-07-11 A/B (edge-tts
  // vs say vs LTX-2.3's own joint audio generation via --dev-audio) confirmed
  // edge-tts is clearly the most natural of the three; LTX's in-prompt "voice"
  // was explicitly rejected on quality. An explicit provider hint still works.
  //
  // 2026-07-13: invoke moved off `mlx:runpy-tts` (a Python subprocess wrapping
  // the SAME Microsoft service) onto `bun:tts-native` (tts_native.ts, backed by
  // the actively-maintained `msedge-tts` npm package) — no Python/MLX-venv
  // dependency for TTS anymore. Verified against the real service: a live call
  // produced a valid 24kHz mono mp3 (ffprobe-confirmed duration + ffmpeg
  // volumedetect mean -22dB, healthy, not near-silent).
  { name: "edge_tts", capability: "tts", provider: "edge-tts", backend: "cloud_http", invoke: "bun:tts-native", configured: true, notes: "Bun-native TTS adapter (src/tts_native.ts, via the `msedge-tts` npm package) — Microsoft neural TTS, same engine `video relay --relay-tts-engine edge-tts` already uses. Natural-sounding voice, near-zero generation cost (~1s per narration), but needs NETWORK EGRESS (not available under --offline). Statically ranked below say_tts, but selectAndGenerate tries it FIRST at runtime by default (see comment above) — falls back to say only on an actual network failure." },
  { name: "say_tts", capability: "tts", provider: "say", backend: "macos_native", invoke: "macos:say", configured: true, notes: "macOS `say` (AVSpeechSynthesizer-backed) — zero-cost, zero-key, fully offline narration; robotic voice quality vs edge_tts. Statically ranked as the default (the correct offline/no-network fallback), but selectAndGenerate opportunistically tries edge-tts first at runtime and only actually invokes say if that fails — see edge_tts's notes." },
  // kokoro_tts — 2026-08-01: run.py tts --engine mlx (local Kokoro-82M via
  // Python's mlx-audio package) was the one remaining Python-only surface in
  // `run.py tts` (edge-tts was already fully native — see edge_tts above),
  // and unlike edge-tts it had NO TS caller at all (runpy_tts.ts never
  // exposed an --engine option). swift/musicgen-director already depends on
  // mlx-audio-swift for MLXAudioCodecs (EnCodec) — that same package ships a
  // COMPLETE Kokoro implementation (MLXAudioTTS product,
  // Models/StyleTTS2/Kokoro/), so this port is CLI + bridge wiring, not a
  // from-scratch model port like MusicGen was. See
  // .planning/specs/2026-08-01-kokoro-tts-swift-native-port-design.md.
  // optIn:true is load-bearing here, not decorative: BACKEND_RANK ranks
  // native_swift above macos_native/cloud_http ACROSS tiers (not just within
  // one), so without optIn this entry would unconditionally win every bare
  // {capability:"tts"} call over say_tts/edge_tts, silently changing their
  // existing default behavior — see selector.ts's header comment. Reachable
  // today only via an explicit `provider:"kokoro"` hint. English (af_*/am_*)
  // and Mandarin (zf_*/zm_*) voices verified (see swift/musicgen-director's
  // KokoroTTSCLITests); other Kokoro-supported languages (es/fr/it/pt/hi/ja)
  // deferred to edge-tts, which already covers them.
  { name: "kokoro_tts", capability: "tts", provider: "kokoro", backend: "native_swift", invoke: "bun:kokoro-tts", configured: true, optIn: true, notes: "swift/musicgen-director's kokoro-tts binary (src/kokoro_tts_native.ts, via ensureBinary()) — local Kokoro-82M TTS via mlx-audio-swift's MLXAudioTTS product, zero Python. Genuinely offline (unlike edge_tts) and higher quality than say_tts, but NOT the default — optIn:true (see selector.ts). Reach it with an explicit provider:\"kokoro\" hint." },

  // Music — native Swift/MLX MusicGen (swift/musicgen-director), the score-track
  // source that compose-motion's amix pass mixes under the narration. Fully
  // local-silicon, no API key, no network egress at generation time.
  //
  // 2026-07-28: invoke moved off `mlx:runpy-music` (a Python subprocess wrapping
  // mlx-audiocraft, requiring the MLX venv + a one-time `uv pip install
  // mlx-audiocraft`) onto `bun:musicgen-native` (music_native.ts, calling the
  // compiled swift/musicgen-director binary directly) — no Python/MLX-venv
  // dependency for music generation anymore. This is a from-scratch Swift/MLX
  // port (T5 text encoder + 24-layer LM decoder + delay-pattern + EnCodec-32kHz
  // decode, CFG+top-k generation), numerically verified layer-by-layer against
  // the Python reference (all cos>=0.99, several at cos=1.00000) and confirmed
  // end-to-end via a Layer-4 spectral sanity comparison against `run.py music`.
  // backend was already "native_swift" here (set ahead of this migration, per
  // the port's design spec) — this change is what makes that label true rather
  // than aspirational. The old `mlx:runpy-music` invoke stays wired (see
  // runpy_music.ts / bridge.ts's realRunPyMusic) for direct/manual use of the
  // Python reference — not deleted, just no longer default. (The Layer-4
  // spectral sanity comparison, python/mlx-movie-director/app/tests/
  // compare_musicgen_e2e.py, shells `run.py music` directly as a subprocess,
  // not through this TS invoke path — the two are independent, not coupled.)
  { name: "musicgen_music", capability: "music_generation", provider: "musicgen", backend: "native_swift", invoke: "bun:musicgen-native", configured: true, notes: "swift/musicgen-director — native Swift/MLX MusicGen-small (src/music_native.ts, via ensureBinary()). Verified numerically against the Python mlx-audiocraft reference at every layer (cos>=0.99 throughout); no Python venv dependency. Local MLX, never a cloud GAI API." },

  // Audio/video post — ffmpeg shells (iteration 3).
  { name: "audio_mixer", capability: "audio_processing", provider: "ffmpeg", backend: "ffmpeg", invoke: "ffmpeg", configured: true },
  { name: "color_grade", capability: "video_post", provider: "ffmpeg", backend: "ffmpeg", invoke: "ffmpeg", configured: true },
  { name: "video_stitch", capability: "video_post", provider: "ffmpeg", backend: "ffmpeg", invoke: "ffmpeg", configured: true },
  { name: "subtitle_gen", capability: "subtitle", provider: "openmontage", backend: "native_swift", invoke: "bun:builtin", configured: true, notes: "pure Bun (SRT/VTT from word timestamps)" },

  // Analysis — Whisper transcriber is wired (Item I: mlx-whisper via the
  // Pure swift/MLX Whisper (ltx-video transcribe) entry, spawned by the
  // bun:whisper adapter. Segment-level timestamps now; per-word DTW is P2b.
  { name: "transcriber", capability: "analysis", provider: "whisper", backend: "native_swift", invoke: "bun:whisper", configured: true, commands: ["transcribe"], notes: "swift/MLX Whisper (ltx-video transcribe) → segment timestamps + transcript" },
  { name: "video_understand", capability: "analysis", provider: "clip", backend: "native_swift", invoke: "bun:clip", configured: true, commands: ["video_understand"], notes: "CLIP video understanding (swift/clip-director, native MLX) — frame×prompt cosine score via ViT-B/32 + projections" },
  { name: "caption_vlm", capability: "analysis", provider: "caption-vlm", backend: "native_swift", invoke: "mlx:caption", configured: true, commands: ["caption"], notes: "Local VLM captioning (run.py caption → gemma brain; Qwen3-VL only as no-gemma fallback). 14 styles incl score/pose_dsg/photography. The explicit callable replacement for OM's 'orchestrator-LLM-is-the-vision-model' assumption — probeConfigured checks run.py+venv presence (model-load is runtime). Emits <image>.caption.json (kind:text artifact)" },

  // Enhancement.
  { name: "bg_remove", capability: "enhancement", provider: "vision", backend: "macos_native", invoke: "macos:vision", configured: true, notes: "macOS Vision VNGeneratePersonSegmentationRequest" },
  // flux2's native `upscale` command (RealPLKSR/ESRGAN, default model
  // 4x-nomos-webphoto-realplksr) — the sole enhancement:upscale provider since
  // the Python/torch-MPS esrgan adapter was removed (2026-07-19, zero-python
  // ext). bridge.ts's normalizeLegacyImageRequest still maps a legacy `image`/
  // `output` request onto flux2's `input`/`output` field names.
  { name: "upscale_flux2", capability: "enhancement", provider: "flux2", backend: "native_swift", invoke: "swift:flux2", configured: true, commands: ["upscale"], notes: "swift/flux2-image-director upscale (RealPLKSR/ESRGAN, native Swift MLX) — the sole upscale provider (esrgan_upscale.py removed 2026-07-19)." },
];

export interface CapabilityRollup {
  capability: Capability;
  total: number;
  configured: number;
  available_providers: string[];
  unavailable_providers: string[];
}

/**
 * The preflight rollup (matches OpenMontage's `provider_menu_summary()` shape).
 * The agent pastes this at the start of a run to see what's wired.
 */
export function providerMenuSummary(): {
  composition_runtimes: Record<string, boolean>;
  capabilities: CapabilityRollup[];
  gaps: ProviderEntry[];
} {
  const caps = new Map<Capability, CapabilityRollup>();
  const gaps: ProviderEntry[] = [];
  for (const p of REGISTRY) {
    if (p.notes?.startsWith("GAP")) gaps.push(p);
    const r = caps.get(p.capability) ?? {
      capability: p.capability,
      total: 0,
      configured: 0,
      available_providers: [],
      unavailable_providers: [],
    };
    r.total += 1;
    if (p.configured) {
      r.configured += 1;
      r.available_providers.push(p.provider);
    } else {
      r.unavailable_providers.push(p.provider);
    }
    caps.set(p.capability, r);
  }
  const composition: Record<string, boolean> = {};
  for (const p of REGISTRY.filter((e) => e.capability === "composition")) {
    composition[p.provider] = p.configured;
  }
  return {
    composition_runtimes: composition,
    capabilities: [...caps.values()].sort((a, b) => a.capability.localeCompare(b.capability)),
    gaps,
  };
}

/** Lookup providers for a capability (the selector primitive). */
export function getByCapability(cap: Capability): ProviderEntry[] {
  return REGISTRY.filter((p) => p.capability === cap);
}
