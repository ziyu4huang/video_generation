/**
 * composition/project-skills.ts — slice 08b2-1 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts:
 * - resolveProjectSkillDiscovery            ← L84-96 (exported)
 * - registerProjectSkillDiscoveryHandler    ← L161-169 incl. its
 *   pi.on("resources_discover") body, extended to the handler's true end
 * - refreshSkillProjectContext              ← L268-275 (private local in
 *   index.ts; de-closured — the captured `skillStore` / `config.projectsMemoryDir`
 *   become parameters, body verbatim)
 *
 * Imports: detectProjectSkills (../project.js), SkillStore
 * (../store/skill-store.js), ExtensionAPI (@earendil-works/pi-coding-agent) —
 * whatever the originals reference.
 *
 * index.ts still holds its own copies until the rewire slice — this module
 * must typecheck standalone; it is not imported yet.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SkillStore } from "../store/skill-store.js";
import { detectProjectSkills } from "../project.js";

export function resolveProjectSkillDiscovery(
	skillStore: SkillStore,
	projectsMemoryDir: string | undefined,
	cwd?: string,
): { skillPaths: string[] } {
	const detected = detectProjectSkills(projectsMemoryDir, cwd);
	skillStore.setProjectContext(detected.name, detected.skillsDir);

	const skillPaths = [skillStore.getGlobalSkillsDir()];
	if (detected.skillsDir) skillPaths.push(detected.skillsDir);

	return { skillPaths };
}

export function registerProjectSkillDiscoveryHandler(
	pi: Pick<ExtensionAPI, "on">,
	skillStore: SkillStore,
	projectsMemoryDir: string | undefined,
): void {
	pi.on("resources_discover", async (event, _ctx) => {
		return resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd);
	});
}

/** ← L268-275: the private refresh closure (session_start / cwd-change skill
 *  project-context refresh). De-closured: captured skillStore + config.projectsMemoryDir
 *  become explicit parameters; body verbatim. */
export function refreshSkillProjectContext(
	skillStore: SkillStore,
	projectsMemoryDir: string | undefined,
	cwd?: string,
) {
	const resource = resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, cwd);
	return {
		name: skillStore.getProjectName(),
		skillsDir: skillStore.getProjectSkillsDir(),
		resource,
	};
}
