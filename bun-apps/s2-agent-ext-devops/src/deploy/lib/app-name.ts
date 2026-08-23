/**
 * app-name.ts — the single source for the deployed artifact name.
 *
 * s2-agent = renamed s2-agent (2026-08-21); upstream deps still
 * @earendil-works/pi-*; update flow unchanged (update-pi.sh).
 *
 * The core bundle, the deployed s2-agent.sh launcher's exec target, and every
 * artifact path derived from them use APP_NAME. Override at build time with
 * S2_APP_NAME (artifact naming only — the workspace folder name and
 * piConfig.name must stay equal, or sibling-dir resolution breaks).
 */
import pkg from "../../../../s2-agent/package.json";

export const APP_NAME: string = process.env.S2_APP_NAME ?? pkg.piConfig?.name ?? "s2-agent";
