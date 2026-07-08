"""planning — deterministic, pure-python storyboard planning layer.

The local counterpart of OpenMontage's ``lib/`` intelligence layer for the IMAGE
storyline path. Two modules:

- :mod:`app.planning.scene_spec` — the 5-aspect scene spec
  (Subject/Motion/Scene/Framing/Camera) + :func:`plan_storyboard`, the
  deterministic backbone a gemma planning call fills in (story → scene list →
  shot specs). Pure data, no generation.
- :mod:`app.planning.shot_prompt_builder` — the 5-layer generation-prompt builder
  (Camera/Movement/Subject/Lighting/Style), ported from OM's
  ``lib/shot_prompt_builder.py`` and adapted to the local run.py image stack.

Together they implement OM's ``scene_plan → shot_prompt_builder → image`` flow
locally, gemma-planned, zero cloud (constraint 2). See Step 3 of
``output/next-goal-20260708-210000.md``.
"""
