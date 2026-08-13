/**
 * Adapter configuration for the Gatus boundary: the base URL of the
 * operator's Gatus instance and the request timeout.
 *
 * Gatus is self-hosted, so — matching Beszel's and Termix's config, and
 * unlike Cloudflare/Purelymail's fixed provider hosts — there is no
 * production base URL to default to. The base URL is REQUIRED, and it is
 * non-secret connection config rather than part of the credential bundle;
 * see `gatus_credentials` in `@loxep/domain`.
 */
import { z } from "zod";
import { GatusAdapterError } from "./errors.ts";

/** No sane default exists for a self-hosted instance; a doc example only. */
export const GATUS_EXAMPLE_BASE_URL = "http://localhost:8080";

export const GATUS_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Normalize an instance base URL to origin + path prefix with no trailing
 * slash. A trailing slash is stripped (operators paste from a browser bar);
 * a query string, fragment, or embedded userinfo is rejected — userinfo
 * matters specifically because `https://user:pass@host/` would put a
 * password into `connections.config`, which is not encrypted.
 */
export function normalizeGatusBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new GatusAdapterError(
      "invalid_request",
      "Gatus base URL is not a valid absolute URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GatusAdapterError(
      "invalid_request",
      "Gatus base URL must use http or https",
      { protocol: parsed.protocol },
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new GatusAdapterError(
      "invalid_request",
      "Gatus base URL must not embed credentials; store them on the connection",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new GatusAdapterError(
      "invalid_request",
      "Gatus base URL must not carry a query string or fragment",
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

export const gatusAdapterConfigSchema = z.object({
  baseUrl: z.string().min(1),
  timeoutMs: z.number().int().positive().default(GATUS_DEFAULT_TIMEOUT_MS),
});

export type GatusAdapterConfigInput = z.input<typeof gatusAdapterConfigSchema>;

export interface GatusAdapterConfig {
  baseUrl: string;
  timeoutMs: number;
}

export function parseGatusAdapterConfig(input: unknown): GatusAdapterConfig {
  const result = gatusAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new GatusAdapterError(
      "invalid_request",
      `invalid Gatus adapter config: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  return {
    baseUrl: normalizeGatusBaseUrl(result.data.baseUrl),
    timeoutMs: result.data.timeoutMs,
  };
}

/**
 * The stable key identifying "which Gatus instance this connection speaks
 * to", used to detect two connections pointed at the same instance.
 *
 * Base URL ALONE, unlike Beszel's `baseUrl|email` composite: Gatus's Basic
 * auth username is not necessarily a stable per-account identity the way a
 * Beszel readonly user's email is (an operator may leave Basic auth
 * unconfigured entirely, or every connection may share one instance-wide
 * username), and the OIDC-degraded path authenticates with no credential at
 * all — so the base URL is the only fact guaranteed to exist for every
 * connection.
 */
export function gatusSourceAccountKey(baseUrl: string): string {
  return normalizeGatusBaseUrl(baseUrl);
}
