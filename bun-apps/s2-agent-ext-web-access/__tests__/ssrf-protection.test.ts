/**
 * ssrf-protection.test.ts — deterministic SSRF guard tests for validateRemoteUrl.
 *
 * validateRemoteUrl accepts an injectable `lookup` (DNS resolver), so every test
 * is network-free: we feed it mock resolutions and assert it blocks/accepts the
 * right addresses. This is the security-critical path — a regression here means
 * the agent could be tricked into hitting internal/metadata endpoints.
 */
import { test, expect, describe } from "bun:test";
import { validateRemoteUrl, type LookupAddress } from "../ssrf-protection.ts";

const addr = (address: string, family = 4): LookupAddress => ({ address, family });
const lookup = (...addresses: LookupAddress[]) => async () => addresses;

describe("validateRemoteUrl — protocol + hostname guards", () => {
	test("rejects non-HTTP(S) protocols", async () => {
		await expect(validateRemoteUrl("file:///etc/passwd")).rejects.toThrow(/Only HTTP and HTTPS/);
		await expect(validateRemoteUrl("ftp://example.com/x")).rejects.toThrow(/Only HTTP and HTTPS/);
	});

	test("rejects localhost / .localhost hostnames", async () => {
		await expect(validateRemoteUrl("http://localhost/admin")).rejects.toThrow(/Blocked internal hostname/);
		await expect(validateRemoteUrl("http://api.localhost/x")).rejects.toThrow(/Blocked internal hostname/);
	});

	test("accepts a well-formed https URL (happy path)", async () => {
		const url = await validateRemoteUrl("https://example.com/", { lookup: lookup(addr("93.184.216.34")) });
		expect(url.hostname).toBe("example.com");
	});
});

describe("validateRemoteUrl — literal-IP SSRF blocks", () => {
	// Literal IPs are parsed directly and never hit DNS. The nip.io case below is a
	// hostname, so it exercises the resolve→private-check path — we inject a
	// deterministic `lookup` (resolves to 127.0.0.1) so the test never depends on
	// real DNS (nip.io cold-resolve flaked CI at the 5s ceiling).
	test("blocks loopback", async () => {
		await expect(validateRemoteUrl("http://127.0.0.1/")).rejects.toThrow();
		await expect(
			validateRemoteUrl("http://127.0.0.1.nip.io/", { lookup: lookup(addr("127.0.0.1")) }),
		).rejects.toThrow();
	});

	test("blocks RFC1918 private ranges", async () => {
		await expect(validateRemoteUrl("http://10.0.0.1/")).rejects.toThrow();
		await expect(validateRemoteUrl("http://192.168.1.1/")).rejects.toThrow();
		await expect(validateRemoteUrl("http://172.16.0.1/")).rejects.toThrow();
	});

	test("blocks link-local + cloud metadata endpoints (169.254.169.254)", async () => {
		// 169.254.169.254 is the AWS/GCP/Azure instance-metadata SSRF target.
		await expect(validateRemoteUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
	});

	test("blocks IPv6 loopback", async () => {
		await expect(validateRemoteUrl("http://[::1]/")).rejects.toThrow();
	});
});

describe("validateRemoteUrl — DNS-resolution SSRF blocks", () => {
	test("rejects when DNS resolves to a private address (DNS rebinding defense)", async () => {
		// Attacker controls evil.com → resolves to an internal IP.
		await expect(
			validateRemoteUrl("https://evil.com/", { lookup: lookup(addr("10.0.0.5")) }),
		).rejects.toThrow();
	});

	test("rejects when ANY resolved address is private (mixed-resolution)", async () => {
		await expect(
			validateRemoteUrl("https://evil.com/", {
				lookup: lookup(addr("93.184.216.34"), addr("169.254.169.254")),
			}),
		).rejects.toThrow();
	});

	test("accepts when all resolved addresses are public", async () => {
		const url = await validateRemoteUrl("https://example.com/", {
			lookup: lookup(addr("93.184.216.34"), addr("2606:2800:220:1:248:1893:25c8:1946", 6)),
		});
		expect(url.hostname).toBe("example.com");
	});

	test("surfaces a clear error when DNS lookup throws", async () => {
		await expect(
			validateRemoteUrl("https://nonexistent.invalid/", {
				async lookup() {
					throw new Error("ENOTFOUND");
				},
			}),
		).rejects.toThrow(/Failed to resolve nonexistent.invalid: ENOTFOUND/);
	});

	test("errors when DNS returns no addresses", async () => {
		await expect(
			validateRemoteUrl("https://empty.invalid/", { lookup: lookup() }),
		).rejects.toThrow(/no addresses returned/);
	});
});

describe("validateRemoteUrl — allowRanges exemption", () => {
	test("an allowed CIDR permits an otherwise-blocked range", async () => {
		// 198.18.0.0/15 is reserved (benchmarking); blocked by default, but a
		// TUN-proxy host (Surge/Clash) legitimately resolves there.
		await expect(validateRemoteUrl("http://198.18.0.1/")).rejects.toThrow();
		const url = await validateRemoteUrl("http://198.18.0.1/", { allowRanges: ["198.18.0.0/15"] });
		expect(url.hostname).toBe("198.18.0.1");
	});
});
