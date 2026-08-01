/**
 * memory_supersede tool — agent-driven supersession.
 *
 * Retire a stale/wrong memory by creating a linked replacement. The prior is
 * flipped to `status='superseded'` (hidden from default search via the Task 3/4
 * status filter); the replacement carries lineage (`supersedes`/`parentIds`)
 * back to it.
 *
 * CRITICAL SEAM: the replacement's DB id is captured from
 * `memoryRepo.syncMemoryEntry(...).entry.id`. The legacy `syncAddToSqlite`
 * helper (in memory-tool.ts) intentionally DISCARDS the id (it returns only a
 * warning string), so this tool calls `syncMemoryEntry` directly — without the
 * captured id there is nothing to flip lineage onto.
 *
 * Flow:
 *   1. `store.add`          — write the replacement to Markdown (.md is the
 *                             source of truth; the .md layer has no lineage).
 *   2. `syncMemoryEntry`    — mirror the replacement into the search store and
 *                             CAPTURE the new row id.
 *   3. `supersedeMemory`    — flip prior→superseded + stamp new→supersedes.
 *   4. probe (`searchMemories`) — best-effort verification that the replacement
 *                             is searchable and the prior is hidden.
 *
 * Partial-failure mode: if step 3 throws AFTER step 2 succeeded, the
 * replacement is persisted (both .md and DB) but lineage is unlinked. This is
 * RECOVERABLE — the agent can retry `memory_supersede` with the same
 * prior_id/replacement (syncMemoryEntry dedups on content, so the retry reuses
 * the same new row id). We report `linked:false` + a retry hint and never fail
 * the whole tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { MemoryRepository, MemoryTarget } from "../store/repository.js";
import type { MemoryStore } from "../store/memory-store.js";
import type { MemorySource } from "../types.js";

interface SupersedeProbe {
  replacementPresent: boolean;
  priorAbsent: boolean;
}

/** Structured result for every exit path. Optional fields are absent on the
 * soft-failure branches so the unified type keeps `registerTool`'s inferred
 * `TDetails` stable across all returns (mirrors memory-search-tool's
 * `SearchResult` pattern). */
interface SupersedeDetails {
  ok: boolean;
  linked: boolean;
  newId?: number;
  priorId: number;
  probe?: SupersedeProbe;
}

export function registerMemorySupersedeTool(
  pi: ExtensionAPI,
  memoryRepo: MemoryRepository | null,
  store: MemoryStore,
  projectName?: string | null,
): void {
  pi.registerTool({
    name: "memory_supersede",
    label: "Memory Supersede",
    description:
      "Retire a stale/wrong memory by creating a linked replacement. The prior is marked superseded (hidden from search); the replacement carries lineage back to it. " +
      "Use when a recalled memory is wrong and you have the correction. Pass the prior's DB id (from a memory_search result) + the corrected content.",
    parameters: Type.Object({
      prior_id: Type.Integer({
        description: "The DB id of the memory to retire (from a memory_search result).",
      }),
      replacement: Type.String({
        description: "The corrected memory content (becomes a new active entry).",
      }),
      target: StringEnum(["memory", "user", "failure"] as const, {
        description: "Which memory home the replacement belongs in (defaults alongside the prior).",
      }),
      project: Type.Optional(
        Type.String({
          description:
            "Project scope for the replacement. Omit for a global memory (recommended unless the prior was project-scoped).",
        }),
      ),
      sources: Type.Optional(
        Type.Array(
          Type.Object({
            kind: Type.String({ description: "Source kind, e.g. \"quote\", \"doc\", \"url\"." }),
            locator: Type.String({ description: "Stable ref into the source (session id, url, line)." }),
            capture: Type.String({ description: "The verbatim text/anchor grounding the replacement." }),
          }),
          { description: "Optional grounding sources attached to the replacement (.md-resident only)." },
        ),
      ),
    }),
    async execute(
      _toolCallId: string,
      args: { prior_id: number; replacement: string; target: MemoryTarget; project?: string; sources?: MemorySource[] },
    ) {
      const { prior_id, replacement, target, project, sources } = args;

      // The .md layer has no project concept at the store.add level (project
      // scoping lives in separate projectStores upstream); the replacement
      // always lands in the global MEMORY/USER/FAILURE.md here. The search
      // store gets the explicit project below.
      const addRes = await store.add(target, replacement, sources && sources.length > 0 ? { sources } : {});
      if (!addRes.success) {
        const details: SupersedeDetails = { ok: false, linked: false, priorId: prior_id };
        return {
          content: [
            {
              type: "text" as const,
              text: `Supersede failed: replacement was not saved — ${addRes.error ?? "add failed"}.`,
            },
          ],
          details,
        };
      }

      // No search store → nothing to link or verify. The .md write already
      // succeeded, so this is a soft success (ok:true, linked:false).
      if (!memoryRepo) {
        const details: SupersedeDetails = { ok: true, linked: false, priorId: prior_id };
        return {
          content: [
            {
              type: "text" as const,
              text: "Replacement saved to Markdown, but no search store is configured — lineage could not be linked.",
            },
          ],
          details,
        };
      }

      try {
        // The tool's `target` is already memory/user/failure (no "project"
        // variant), so the sqlite-target mapping is identity here. Project
        // defaults to null (global) when the agent omits it — matching the
        // memory/user/failure convention in sqliteProjectFor.
        const sqliteTarget: MemoryTarget = target;
        const sqliteProject = project ?? null;

        // Step 2: sync + CAPTURE the new id. (Do NOT reuse syncAddToSqlite —
        // it discards the id and returns only a warning string.) Task 7 / F1:
        // thread the birth id (addRes.added_md_id) so the replacement row's
        // md_id == the `.md` frontmatter id — the live-in-session bridge.
        const syncRes = await memoryRepo.syncMemoryEntry({
          content: replacement,
          target: sqliteTarget,
          project: sqliteProject,
          ...(addRes.added_md_id ? { mdId: addRes.added_md_id } : {}),
        });
        const newId = syncRes.entry.id;

        // Step 3: flip lineage. Best-effort — a throw here is recoverable
        // (caught below) since the replacement is already persisted.
        await memoryRepo.supersedeMemory(prior_id, newId);

        // Step 4: best-effort verification probe. Search a 3-word slice of the
        // replacement as a lexical handle. searchMemories hides superseded
        // entries by default (Task 3/4 status filter), so priorAbsent is the
        // filter doing its job — NOT lexical luck. Never fail the tool if the
        // probe throws; degrade to probe:undefined.
        let probe: SupersedeProbe | undefined;
        try {
          const handle = replacement
            .split(/\s+/)
            .slice(0, 3)
            .join(" ")
            .trim();
          const hits =
            handle.length > 0
              ? await memoryRepo.searchMemories(handle, {
                  target: sqliteTarget,
                  project: sqliteProject,
                })
              : [];
          probe = {
            replacementPresent: hits.some((h) => h.id === newId),
            priorAbsent: !hits.some((h) => h.id === prior_id),
          };
        } catch {
          probe = undefined;
        }

        const probeText = probe
          ? ` Probe: replacement ${probe.replacementPresent ? "present" : "MISSING"}, prior ${probe.priorAbsent ? "hidden" : "LEAKED"}.`
          : " Probe skipped (search unavailable).";

        const details: SupersedeDetails = {
          ok: true,
          linked: true,
          newId,
          priorId: prior_id,
          probe,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Superseded memory #${prior_id} with #${newId}.${probeText}`,
            },
          ],
          details,
        };
      } catch (err) {
        // Replacement saved to BOTH .md and the search store, but lineage link
        // failed. Recoverable: retry memory_supersede (syncMemoryEntry dedups
        // on content, so the retry reuses the same new row id).
        const reason = err instanceof Error ? err.message : String(err);
        const details: SupersedeDetails = { ok: true, linked: false, priorId: prior_id };
        return {
          content: [
            {
              type: "text" as const,
              text: `Replacement saved to Markdown and the search store, but lineage link failed: ${reason}. (Recoverable — retry memory_supersede.)`,
            },
          ],
          details,
        };
      }
    },
  });
}
