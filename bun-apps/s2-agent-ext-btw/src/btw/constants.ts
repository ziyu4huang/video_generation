/**
 * BTW — side conversation channel — string constants.
 *
 * Adapted from pi-btw (MIT, Dan Bachelder). These constants define the custom
 * session entry types used to persist BTW state across session reloads.
 */

/** Visible BTW note saved to the session transcript (--save flag). */
export const BTW_MESSAGE_TYPE = "btw-note" as const;

/** Hidden thread entry — persists a single BTW exchange. */
export const BTW_ENTRY_TYPE = "btw-thread-entry" as const;

/** Reset marker — clears the BTW thread, optionally switching mode. */
export const BTW_RESET_TYPE = "btw-thread-reset" as const;

/** Model override persisted across session reloads. */
export const BTW_MODEL_OVERRIDE_TYPE = "btw-model-override" as const;

/** Thinking override persisted across session reloads. */
export const BTW_THINKING_OVERRIDE_TYPE = "btw-thinking-override" as const;
