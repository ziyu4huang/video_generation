<!-- RUN WITH deepseek-v4-flash, NOT gemma: `--model deepseek-v4-flash --thinking medium`.
     gemma stalls on creative-waypoint schema validation + mis-passes generate args
     (3 failed full-chain attempts 2026-07-18/19). See memory:
     movie-director-agent-driven-use-deepseek-not-gemma.md -->
Non-interactive batch run. Proceed immediately, autonomously. Make all creative
decisions yourself (style: vivid scientific/realistic).

HARD RULES:
- Use ONLY the `movie` and `movie_help` tools. Do NOT call `bash`, `read`, `write`,
  `edit`, `grep`, or any other tool. Do NOT invoke run.py or any python directly.
- Do NOT ask me anything. If a step fails, read the error, call `movie_help <command>`
  for the exact option keys, and retry with corrected args.

Concept: "how a rainbow forms — sunlight refracting and dispersing through raindrops
into a spectrum". Pipeline: `animated-explainer`. projectId: `rainbow-verify`.

CRITICAL — the `movie` command surface. Stage names are NOT all commands. Advance each
stage with the EXACT command shown:

1. `movie init-project` { projectId:"rainbow-verify", pipeline:"animated-explainer" }
   → note the returned projectDir + assetsDir; use assetsDir (absolute) as `outputDir`
   for every `generate` call so files land inside the project.

2. CREATIVE WAYPOINTS — for each, call `movie <stage>` to produce the artifact, then
   `movie write-checkpoint` { projectId, pipeline:"animated-explainer", stage:<stage>,
   status:"completed", humanApproved:true, artifacts:{<stage>_artifact:<the artifact>} }.
   Stages + their artifact key:
     - `movie research` { projectId, prompt:"..." }  → research_brief
     - `movie proposal` { projectId }                 → proposal_packet
     - `movie script`     { projectId }               → script
     - `movie scene_plan` { projectId }               → scene_plan
   Call `movie_help <stage>` first if unsure of the option keys. Keep artifacts concise
   but schema-shaped; call `movie validate-artifact` { artifact:<...> } before
   write-checkpoint if you want to check.

3. ASSETS (mechanical — NOT `movie assets`). TWO scenes. For EACH scene do:
     a. `movie generate` { capability:"image_generation", command:"t2i",
        options:{ prompt:"<scene visual>" }, outputDir:<assetsDir> }
     b. `movie generate` { capability:"video_generation", command:"native-i2v",
        options:{ prompt:"<scene visual>", seconds:1 }, outputDir:<assetsDir> }
   Collect the returned artifact paths. Then:
     `movie write-checkpoint` { projectId, pipeline, stage:"assets", status:"completed",
       humanApproved:true, artifacts:{ asset_manifest:{ scenes:[ {id, image_path,
       video_path, prompt} ... ] } } }

4. EDIT (creative waypoint): `movie edit` { projectId } → edit_decisions, then
   `movie write-checkpoint` { stage:"edit", status:"completed", artifacts:{edit_decisions:<...>} }.

5. COMPOSE (mechanical):
     - `movie pre-compose` { projectId }   (gate; note verdict)
     - `movie compose-motion` { projectId } → render_report (has the final mp4 path)
     - `movie write-checkpoint` { stage:"compose", status:"completed",
       artifacts:{ render_report:<the render_report> } }

6. PUBLISH (mechanical):
     - `movie final-review` { projectId }  → final_review verdict
     - `movie write-checkpoint` { stage:"publish", status:"completed", humanApproved:true,
       artifacts:{ publish_log:{ version:"1.0", entries:[{platform:"local",
       status:"exported", timestamp:<now>, export_path:<final mp4 abs path>}] } } }

When publish is completed, report: final mp4 absolute path + a one-line per-stage status
table (research/proposal/script/scene_plan/assets/edit/compose/publish). Do NOT use
overrideArtifactValidation / overrideFinalReview / overrideRequiredArtifacts. Begin now
with `movie init-project`.
