/**
 * @repo/pi-agent-ext-hyperframes — lib face (src-entry convention).
 *
 * This package ships SKILLS, not tools: the eight vendored HyperFrames-family
 * skill trees under ../skills/ are the payload, wired through package.json's
 * `pi.skills`, pi-agent/run-dir/manifest.json's `skills` + `binarySkills`,
 * and deploy-config.yaml's `skills:` key for the sh deploy.
 *
 * The factory below is a deliberate no-op. It exists so every registration
 * surface (run-dir manifest, static-extensions.ts, the sh ext build) has the
 * uniform extensions/<X>.ts code path to point at — the pipelines expect an
 * extension entry even for a skills-only package.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const extension: ExtensionFactory = () => {};

export default extension;
