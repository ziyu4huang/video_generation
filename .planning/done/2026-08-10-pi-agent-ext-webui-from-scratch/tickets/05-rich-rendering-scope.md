# 05 — Rich rendering scope

type: grilling
blocked by: 04
status: closed
resolved: 2026-08-12

> **Spec'd (session decision).** Resolved as **generic tool-mirror only** — subscribe `tool_result`, format each result's typed `details` into markdown, render a single accumulating "tools" view; **ALL dedicated renderers (image/video inline preview, manifest/table, diff viewer, file-tree) AND binary-artifact serving deferred** to v1-out-of-scope. See ../specs/05-rich-rendering.md + ../plans/05-rich-rendering-plan.md.

## Question

For **rich rendering**, is generic "forward all `tool_execution_*` + `details`" enough for v1, or do we build dedicated renderers for high-value artifacts (images, videos, manifests, diffs, file trees)? Where is the line for the minimal MVP?

## Context

- Structured `details` already exist per tool (`edit`→`{diff,patch}`, `bash`→`{exitCode,fullOutputPath}`, …) plus type guards (`isEditToolResult`, `isBashToolResult`, …).
- v1 preference (map Notes): **minimal MVP** — generic event forwarding first. The question is whether ANY artifact type is must-have for v1 (e.g. rendering a generated image inline) or all dedicated renderers defer.
- This repo is video-generation-heavy, so image/video/manifest rendering is the tempting scope-creep — name the boundary explicitly.

## What resolving looks like

A grilling decision: the v1 rendering set (likely "generic only, defer all dedicated renderers") with the deferred list recorded, OR a small named must-have set. Depends on 04 (the protocol carries the `details`).
