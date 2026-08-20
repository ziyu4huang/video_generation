/**
 * Skill manager tool — registers the LLM-callable `skill_manage` tool for procedural memory.
 * Complements the `memory` tool (declarative knowledge) with procedural knowledge.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { SkillStore } from "../store/skill-store.js";
import { SKILL_TOOL_DESCRIPTION, SKILL_REFERENCE_TEXT } from "../constants.js";

// ─── Gate family (wayfinder ticket 02 — demoted from core) ──────────────────
GATE_DEFS["skill_manage"] = {
  id: "skill_manage",
  keywords: ["skill manage", "skill manager", "create skill", "list skills", "patch skill", "edit skill", "delete skill", "skill 管理", "技能"],
  requires: {
    nouns: ["skill", "skills", "技能", "skill_id"],
    verbs: ["create", "view", "list", "patch", "update", "edit", "delete", "manage", "建立", "管理", "修改"],
  },
  description: "Skill manager CRUD (create/view/patch/update/edit/delete)",
};

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatOrderedList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function formatBulletList(items: string[], fallback: string): string {
  if (items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}

type SkillResultLike = {
  success?: boolean;
  error?: string;
  message?: string;
  skillId?: string;
  scope?: string;
  suggestedAction?: string;
};

/** Human-readable one-line summary for skill_manage results (success + failure).
 * Replaces the raw JSON.stringify dump that showed in the TUI. */
function formatSkillResultLine(result: SkillResultLike): string {
  if (!result.success) {
    const detail = result.error ?? "Operation failed";
    const hint = result.suggestedAction ? ` (try '${result.suggestedAction}')` : "";
    return `✗ ${detail}${hint}`;
  }
  const head = result.message ?? "Done";
  const id = result.skillId ? ` [${result.scope ?? "skill"}:${result.skillId}]` : "";
  return `✓ ${head}${id}`;
}

/** Build a skill tool response carrying a human-readable `text` for the TUI and
 * the structured `details` for programmatic/test consumers. Use for errors. */
function skillErrorResponse(error: string): { content: Array<{ type: "text"; text: string }>; details: { success: false; error: string } } {
  const result = { success: false as const, error };
  return { content: [{ type: "text", text: formatSkillResultLine(result) }], details: result };
}

/** Render a loaded skill document readably (name + description + body) for the
 * `view` action, instead of a raw JSON dump. */
function formatSkillDoc(doc: { displayName?: string; name?: string; description?: string; body?: string }): string {
  const name = doc.displayName ?? doc.name ?? "skill";
  const description = doc.description;
  const body = doc.body ?? "";
  const lines = [name, ...(description ? [description] : []), ...(body ? ["", body] : [])];
  return lines.join("\n").trim();
}

function buildStructuredSkillBody(
  whenToUse: string,
  procedureSteps: string[],
  pitfalls: string[],
  verificationSteps: string[],
): string {
  return [
    "## When to Use",
    whenToUse,
    "",
    "## Procedure",
    formatOrderedList(procedureSteps),
    "",
    "## Pitfalls",
    formatBulletList(pitfalls, "No notable pitfalls recorded yet."),
    "",
    "## Verification",
    formatOrderedList(verificationSteps),
  ].join("\n");
}

const SKILL_ID_PARAM = Type.String({
  description: "Stable skill id for view/patch/update/delete. e.g., 'global:debug-typescript-errors' or 'project:my-repo:release-app'. Legacy alias 'edit' also accepts this field.",
});

const SKILL_TOOL_PARAMETERS = Type.Object({
  action: StringEnum(["create", "view", "patch", "update", "edit", "delete"] as const, {
    description: "The skill action to perform.",
  }),
  name: Type.Optional(Type.String({
    description: "Skill name for create. e.g., 'debug-typescript-errors'.",
  })),
  skill_id: Type.Optional(SKILL_ID_PARAM),
  description: Type.Optional(Type.String({
    description: "One-line description of when to use this skill. Required for create; optional for update/edit.",
  })),
  scope: Type.Optional(StringEnum(["global", "project"] as const, {
    description: "Required for create. Use 'global' for portable procedures and 'project' for repo-specific workflows.",
  })),
  section: Type.Optional(Type.String({
    description: "Required for patch. Section header to patch. e.g., 'Procedure', 'Pitfalls'.",
  })),
  content: Type.Optional(Type.String({
    description: "Raw markdown body for create/update/edit, or new section content for patch. For create/update/edit you can provide this or the structured fields below.",
  })),
  when_to_use: Type.Optional(Type.String({
    description: "Structured create/update/edit field. Explain when this skill should be used and where its boundaries are.",
  })),
  procedure_steps: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field. Ordered concrete steps for the workflow.",
  })),
  pitfalls: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field. Optional common mistakes, caveats, or failure modes to avoid.",
  })),
  verification_steps: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field. Concrete checks that confirm the workflow succeeded.",
  })),
}, { additionalProperties: false });

export const SKILL_MANAGE_TOOL_NAME = "skill_manage";

export function registerSkillTool(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerTool({
    name: SKILL_MANAGE_TOOL_NAME,
    label: "Skill Manager",
    gating: { gate: "skill_manage" }, // demoted from core (ticket 02)
    description: SKILL_TOOL_DESCRIPTION,
    parameters: SKILL_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const skillParams = params as {
        action: "create" | "view" | "patch" | "update" | "edit" | "delete";
        name?: string;
        skill_id?: string;
        description?: string;
        scope?: "global" | "project";
        section?: string;
        content?: string;
        when_to_use?: string;
        procedure_steps?: unknown;
        pitfalls?: unknown;
        verification_steps?: unknown;
      };
      const {
        action,
        name,
        skill_id,
        description,
        scope,
        section,
        content,
        when_to_use,
        procedure_steps,
        pitfalls,
        verification_steps,
      } = skillParams;

      const whenToUse = typeof when_to_use === "string" ? when_to_use.trim() : "";
      const procedureSteps = normalizeTextList(procedure_steps);
      const pitfallItems = normalizeTextList(pitfalls);
      const verificationSteps = normalizeTextList(verification_steps);
      const hasStructuredBody = Boolean(whenToUse) || procedureSteps.length > 0 || pitfallItems.length > 0 || verificationSteps.length > 0;

      const buildBodyOrError = () => {
        if (content?.trim()) return { body: content.trim() };
        if (!hasStructuredBody) {
          return {
            error: "Either content or structured fields are required. Prefer when_to_use, procedure_steps, pitfalls, and verification_steps for create/update.",
          };
        }
        if (!whenToUse) {
          return { error: "when_to_use is required when content is omitted." };
        }
        if (procedureSteps.length === 0) {
          return { error: "procedure_steps is required when content is omitted." };
        }
        if (verificationSteps.length === 0) {
          return { error: "verification_steps is required when content is omitted." };
        }
        return {
          body: buildStructuredSkillBody(whenToUse, procedureSteps, pitfallItems, verificationSteps),
        };
      };

      let result;
      switch (action) {
        case "create":
          if (!name) {
            return skillErrorResponse("name is required for 'create' action.");
          }
          if (!description) {
            return skillErrorResponse("description is required for 'create' action.");
          }
          const createBodyResult = buildBodyOrError();
          if (!createBodyResult.body) {
            return skillErrorResponse(createBodyResult.error ?? "Invalid skill body.");
          }
          if (!scope) {
            return skillErrorResponse("scope is required for 'create' action. Use 'global' or 'project'.");
          }
          result = await store.create(name, description, createBodyResult.body, scope);
          break;

        case "view":
          if (!skill_id) {
            const index = await store.loadIndex();
            const ids = index.map((s) => s.displayName ?? s.skillId);
            const text = ids.length > 0
              ? `Skills (${ids.length}):\n${formatOrderedList(ids)}`
              : "No skills found.";
            return {
              content: [{ type: "text", text }],
              details: { success: true, skills: index },
            };
          }
          const doc = await store.loadSkill(skill_id);
          if (!doc) {
            return skillErrorResponse(`Skill '${skill_id}' not found.`);
          }
          return {
            content: [{ type: "text", text: formatSkillDoc(doc) }],
            details: { success: true, ...doc },
          };

        case "patch":
          if (!skill_id) {
            return skillErrorResponse("skill_id is required for 'patch' action.");
          }
          if (!section) {
            return skillErrorResponse("section is required for 'patch' action.");
          }
          if (!content) {
            return skillErrorResponse("content is required for 'patch' action.");
          }
          result = await store.patch(skill_id, section, content);
          break;

        case "update":
        case "edit": {
          const updateActionLabel = action === "edit" ? "edit" : "update";
          if (!skill_id) {
            return skillErrorResponse(`skill_id is required for '${updateActionLabel}' action.`);
          }
          const updateBodyResult = buildBodyOrError();
          const nextDescription = description?.trim() || "";
          const nextBody = updateBodyResult.body ?? content?.trim() ?? "";
          if (!nextDescription && !nextBody) {
            return skillErrorResponse(`Provide description, content, or structured fields for '${updateActionLabel}'.`);
          }
          if (hasStructuredBody && !updateBodyResult.body) {
            return skillErrorResponse(updateBodyResult.error ?? "Invalid skill body.");
          }
          result = await store.edit(skill_id, nextDescription, nextBody);
          break;
        }

        case "delete":
          if (!skill_id) {
            return skillErrorResponse("skill_id is required for 'delete' action.");
          }
          result = await store.delete(skill_id);
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: create, view, patch, update, delete`,
          };
      }

      return {
        content: [{ type: "text", text: formatSkillResultLine(result as SkillResultLike) }],
        details: result,
      };
    },
  });

  // ── On-demand help tool (~80 tok schema) ────────────────────────────
  // Returns per-action reference text. Reads the SAME SKILL_REFERENCE_TEXT
  // the terse routing description defers — single-sourced, no drift.
  pi.registerTool({
    name: "skill_manage_help",
    label: "Skill Manage Reference",
    description:
      "On-demand reference for the `skill_manage` tool. Call to get the full " +
      "per-action semantics (what each action does, required fields, constraints). " +
      "Executes no skill operation.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      return {
        content: [{ type: "text", text: SKILL_REFERENCE_TEXT }],
        details: { ok: true, reference: "skill_manage" },
      };
    },
  });
}


/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of runtime gating).
 * Consumed by s2-agent-ext-tool-gate/qa/collect-probes.ts. Controls-only
 * (recallFloor 0, adversarial []): demoted from core in ticket 02; narrow
 * keywords are intentional, so we assert the predicate fires on its own
 * keyword/requires path, not paraphrased intent.
 */
export const __GATE_PROBES__ = {
  gate: "skill_manage",
  recallFloor: 0,
  adversarial: [],
  controls: ['create a new skill for running tests', 'list the skills I have', "patch the skill's when_to_use", 'delete the stale skill'],
};
