/**
 * context.ts — `StatusContext`, the shape every goal module receives from pi.
 *
 * Extracted during the goal.ts split (spec 1a) for one reason: it lived in
 * goal.ts, and every module carved out of goal.ts takes it as a parameter. Left
 * where it was, each extraction would have imported back into the facade and
 * turned a one-way graph into a cycle.
 *
 * It cannot live in state.ts (the other candidate) because `ui` is pi's
 * `ExtensionUIContext` and state.ts is deliberately free of @earendil-works/*
 * imports.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export interface StatusContext {
	cwd: string;
	ui: ExtensionUIContext;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	abort?: () => void;
	sessionManager?: unknown;
}
