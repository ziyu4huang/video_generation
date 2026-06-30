/**
 * Map a GUI action identifier to the run.py top-level command string.
 *
 * GUI actions use a `video-` prefix for video sub-commands (e.g. "video-generate",
 * "video-restore") and bare names for image sub-commands (e.g. "t2i", "i2i").
 *
 * run.py uses positional subcommands: `image <action>` or `video <action>`.
 *
 * @returns The full command string, e.g. "image t2i" or "video generate".
 */
export function actionToCommand(action: string): string {
  return action.startsWith("video-")
    ? `video ${action.slice("video-".length)}`
    : `image ${action}`;
}

/**
 * Return just the top-level run.py subcommand ("image" or "video") for the
 * given GUI action. Used by schema-lookup scripts that index run.py's command
 * tree per top-level command.
 */
export function subcommand(action: string): string {
  return action.startsWith("video-") ? "video" : "image";
}
