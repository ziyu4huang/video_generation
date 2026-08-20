/**
 * app-name.ts — the single source for the deployed artifact name.
 *
 * s2-agent = renamed pi-agent (2026-08-21); upstream deps still
 * @earendil-works/pi-*; update flow unchanged (update-pi.sh).
 *
 * The compiled binary, the deployed run.sh's exec target, and every artifact
 * path derived from them use APP_NAME. Override at build time with
 * S2_APP_NAME (artifact naming only — the workspace folder name and
 * piConfig.name must stay equal, or sibling-dir resolution breaks).
 */
import pkg from "../../../pi-agent/package.json";

export const APP_NAME: string = process.env.S2_APP_NAME ?? pkg.piConfig?.name ?? "pi-agent";
