/**
 * Ambient shim for `javascript-obfuscator` — an OPTIONAL runtime dependency
 * (only pulled in by `pi_deploy --obfuscate`, never installed in this
 * workspace). Declares exactly the surface scripts/deploy.ts uses.
 */
declare module "javascript-obfuscator" {
	const JavaScriptObfuscator: {
		obfuscate(code: string, options: Record<string, unknown>): {
			getObfuscatedCode(): string;
		};
	};
	export default JavaScriptObfuscator;
}
