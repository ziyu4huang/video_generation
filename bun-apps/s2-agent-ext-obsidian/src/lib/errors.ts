/**
 * Structured error helpers for the Obsidian extension.
 *
 * Tool failures surface a machine-branchable `code` on `details` so callers can
 * react (retry on CONFLICT, prompt on PERMISSION_DENIED, …) instead of parsing
 * a human string. The prior shape (`details.error = "<lowercase>"` + ad-hoc
 * booleans) is preserved for back-compat; `code` is the canonical field.
 *
 * Extracted from `obsidian-lib.ts` as a leaf module (Phase 1 refactor). This is
 * a pure mechanical move — no body, signature, or JSDoc changes.
 */

/** Extract a human-readable message from any thrown value (Error, string, or unknown). */
export function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === "string") return e;
	const m = (e as Record<string, unknown>)?.message;
	return typeof m === "string" ? m : String(e);
}

// ---- Structured errors (Phase 1: WS-A1 + WS-A2) ---------------------------
// Tool failures surface a machine-branchable `code` on `details` so callers can
// react (retry on CONFLICT, prompt on PERMISSION_DENIED, …) instead of parsing
// a human string. The prior shape (`details.error = "<lowercase>"` + ad-hoc
// booleans) is preserved for back-compat; `code` is the canonical field.
export type ErrCode =
	| "NOT_FOUND"
	| "ALREADY_EXISTS"
	| "CONFLICT"
	| "PERMISSION_DENIED"
	| "OUTSIDE_VAULT"
	| "INVALID_PATH"
	| "IO_ERROR"
	| "BAD_REQUEST";

/** A filesystem/IO error carrying a structured code. Helpers throw this; tool
 *  execute()s catch and turn it into a structured result via toolError(). */
export class VaultError extends Error {
	code: ErrCode;
	constructor(code: ErrCode, message: string) {
		super(message);
		this.name = "VaultError";
		this.code = code;
	}
}

/** Pull the NodeFS error code (e.g. "ENOENT", "EACCES") off any thrown value. */
export function fsErrCode(e: unknown): string | undefined {
	const code = (e as { code?: unknown })?.code;
	return typeof code === "string" ? code : undefined;
}

/** Map a thrown filesystem error to a structured ErrCode. */
export function classifyFsError(e: unknown): ErrCode {
	switch (fsErrCode(e)) {
		case "ENOENT":
		case "ENOTDIR":
			return "NOT_FOUND";
		case "EACCES":
		case "EPERM":
			return "PERMISSION_DENIED";
		case "EEXIST":
			return "ALREADY_EXISTS";
		default:
			return "IO_ERROR";
	}
}

/** Build a structured tool-error result. `extra` is merged into details. */
export function toolError(
	code: ErrCode,
	message: string,
	extra: Record<string, unknown> = {},
): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: true;
} {
	return {
		content: [{ type: "text", text: message }],
		details: { ...extra, code, error: code },
		isError: true,
	};
}

/** Convert a caught value (preferably a VaultError) into a structured result. */
export function toolErrorFromCaught(
	e: unknown,
	extra: Record<string, unknown> = {},
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } {
	if (e instanceof VaultError)
		return toolError(e.code, e.message, extra);
	// A raw NodeFS error: classify it.
	if (fsErrCode(e)) return toolError(classifyFsError(e), errMsg(e), extra);
	return toolError("IO_ERROR", errMsg(e), extra);
}
