import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSkillsCommand } from "../handlers/skills-command.js";
import { registerSwitchProjectCommand } from "../handlers/switch-project.js";
import { registerLearnMemoryCommand } from "../handlers/learn-memory.js";
import { registerSyncMarkdownMemoriesCommand } from "../handlers/sync-markdown-memories.js";
import { registerPreviewContextCommand } from "../handlers/preview-context.js";
import type { HermesCtx } from "./stores.js";

/**
 * Command registrations, extracted verbatim from index.ts
 * (closure locals rewritten to HermesCtx fields).
 */
export function registerCommands(pi: ExtensionAPI, ctx: HermesCtx): void {
	registerSkillsCommand(pi, ctx.skillStore);
	registerSwitchProjectCommand(pi, ctx.config);
	registerLearnMemoryCommand(pi);
	registerSyncMarkdownMemoriesCommand(pi, ctx.memoryRepo, ctx.globalDir, ctx.config.projectsMemoryDir, ctx.agentRoot, () => ctx.backend.get().label, ctx.inRepoProjectFile, ctx.inRepoProjectName, ctx.cardStore);
	registerPreviewContextCommand(pi, ctx.store, ctx.projectStore, ctx.projectName, ctx.config);
}
