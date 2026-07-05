/**
 * StatefulView — a component that can receive props and render.
 * Ported from rpiv-ask-user-question view/stateful-view.ts.
 */
export interface StatefulView<P = Record<string, unknown>> {
	setProps(props: P): void;
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
}
