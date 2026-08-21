/**
 * forge/rest.ts — the shared REST transport for forge adapters.
 *
 * Thin, dependency-free (global fetch; injectable for tests). Kept separate
 * from any one forge's payloads so both a GitHub and a future Gitea adapter
 * share: auth header assembly, GitHub-API-version headers (harmless for
 * Gitea, which ignores unknown Accept/version headers), JSON encode/decode,
 * and the error contract.
 *
 * TOKEN DISCIPLINE: the token value must NEVER appear in an error message or
 * log line — ForgeHttpError carries only the token KIND (where it came from),
 * plus method/path/status/body. `bodyText` is included because callers
 * classify failures by grepping the message (isMissingWorkflowScope matches
 * the forge's refusal text).
 */

export type FetchFn = typeof fetch;

/** Non-2xx response. Message embeds method/path/status/body — grep-able. */
export class ForgeHttpError extends Error {
	readonly status: number;
	readonly method: string;
	readonly path: string;
	/** The raw response body text (best-effort, truncated for sanity). */
	readonly bodyText: string;

	constructor(method: string, path: string, status: number, bodyText: string) {
		const clipped = bodyText.length > 2000 ? `${bodyText.slice(0, 2000)}…[truncated]` : bodyText;
		super(`REST ${method} ${path} → HTTP ${status}: ${clipped}`);
		this.name = "ForgeHttpError";
		this.status = status;
		this.method = method;
		this.path = path;
		this.bodyText = bodyText;
	}
}

/** Network-level failure (DNS, refused, timeout, TLS). Never carries the token. */
export class ForgeNetworkError extends Error {
	constructor(method: string, path: string, cause: unknown) {
		super(`REST ${method} ${path} failed before a response: ${String(cause)}`);
		this.name = "ForgeNetworkError";
	}
}

export interface RestTransportOptions {
	/** Base URL WITHOUT a trailing slash, e.g. `https://api.github.com`. */
	baseUrl: string;
	token: string;
	/** Provenance label for diagnostics ("GITHUB_TOKEN env", "gh auth token", …) —
	 *  the ONLY token-related string allowed in output. */
	tokenKind: string;
	/** Injectable for tests. Defaults to global fetch. */
	fetchFn?: FetchFn;
	/** Extra headers merged over the defaults (e.g. Gitea's token scheme). */
	headers?: Record<string, string>;
}

export interface RestTransport {
	request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
	readonly tokenKind: string;
}

/** Build the shared REST transport. All forge REST calls go through here. */
export function createRestTransport(opts: RestTransportOptions): RestTransport {
	const doFetch = opts.fetchFn ?? fetch;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "s2-agent-ext-devops",
		...opts.headers,
	};
	return {
		tokenKind: opts.tokenKind,
		async request<T>(method: string, path: string, body?: unknown): Promise<T> {
			let res: Response;
			try {
				res = await doFetch(`${opts.baseUrl}${path}`, {
					method,
					headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			} catch (cause) {
				throw new ForgeNetworkError(method, path, cause);
			}
			const text = await res.text();
			if (!res.ok) throw new ForgeHttpError(method, path, res.status, text);
			if (!text) return undefined as T;
			try {
				return JSON.parse(text) as T;
			} catch {
				// 2xx with a non-JSON body: surface it raw rather than crashing —
				// callers treat payloads defensively.
				return text as unknown as T;
			}
		},
	};
}
