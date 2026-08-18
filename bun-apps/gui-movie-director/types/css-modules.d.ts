/**
 * Ambient types for CSS-module imports (`import s from "./X.module.css"`).
 *
 * Bun's bundler resolves these at build time and hands back the class-name map,
 * but TypeScript has no built-in knowledge of the extension — without this every
 * such import is a TS2307 "cannot find module". The package had no `typecheck`
 * script until now, so those 7 errors sat unreported rather than being fixed.
 *
 * `Record<string, string>` rather than a generated per-file union: the class
 * names are not extracted at typecheck time, so a stricter type here would be a
 * fiction that fails on correct code.
 */
declare module "*.module.css" {
	const classes: Record<string, string>;
	export default classes;
}
