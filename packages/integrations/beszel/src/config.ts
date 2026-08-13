/**
 * Adapter configuration for the Beszel boundary: the base URL of the hub, the
 * request timeout, and the derived source-account key.
 *
 * Beszel is **self-hosted**, so unlike Cloudflare or Purelymail there is no
 * production base URL to default to. The operator's hub could be
 * `http://localhost:8090` (the value Beszel's own REST guide uses,
 * https://beszel.dev/guide/rest-api), a LAN address, or a TLS reverse proxy.
 * The base URL is therefore REQUIRED, and it is non-secret connection config
 * rather than part of the credential bundle — see `beszel_credentials` in
 * `@loxep/domain`.
 */
import { z } from "zod";
import { BeszelAdapterError } from "./errors.ts";

/** No sane default exists for a self-hosted hub; this is only a doc example. */
export const BESZEL_EXAMPLE_BASE_URL = "http://localhost:8090";

export const BESZEL_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Normalize a hub base URL to origin + path prefix with no trailing slash.
 *
 * A trailing slash is stripped rather than rejected because operators paste
 * URLs out of a browser bar, and `…:8090/` + `/api/health` would otherwise
 * produce a double slash that some reverse proxies 404.
 *
 * A URL carrying a query string, a fragment, or **userinfo** is rejected.
 * Userinfo matters specifically: `https://user:pass@hub/` would put a password
 * into `connections.config`, which is not encrypted, and into every error
 * detail that records a path.
 */
export function normalizeBeszelBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new BeszelAdapterError(
      "invalid_request",
      "Beszel base URL is not a valid absolute URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BeszelAdapterError(
      "invalid_request",
      "Beszel base URL must use http or https",
      { protocol: parsed.protocol },
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new BeszelAdapterError(
      "invalid_request",
      "Beszel base URL must not embed credentials; store them on the connection",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new BeszelAdapterError(
      "invalid_request",
      "Beszel base URL must not carry a query string or fragment",
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

export const beszelAdapterConfigSchema = z.object({
  baseUrl: z.string().min(1),
  timeoutMs: z.number().int().positive().default(BESZEL_DEFAULT_TIMEOUT_MS),
});

export type BeszelAdapterConfigInput = z.input<typeof beszelAdapterConfigSchema>;

export interface BeszelAdapterConfig {
  baseUrl: string;
  timeoutMs: number;
}

export function parseBeszelAdapterConfig(
  input: unknown,
): BeszelAdapterConfig {
  const result = beszelAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new BeszelAdapterError(
      "invalid_request",
      `invalid Beszel adapter config: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  return {
    baseUrl: normalizeBeszelBaseUrl(result.data.baseUrl),
    timeoutMs: result.data.timeoutMs,
  };
}

/**
 * The stable key identifying "which Beszel account this connection speaks as",
 * used to detect two connections pointed at the same hub.
 *
 * Composed of the normalized base URL **and** the account email, because one
 * hub can legitimately hold several Loxep-facing readonly users with different
 * systems shared with each — unlike Purelymail, where the token IS the account
 * and the base URL alone had to serve. The email is non-secret identity that is
 * already in the bundle; it is lower-cased so `Ops@` and `ops@` do not look
 * like two accounts.
 */
export function beszelSourceAccountKey(
  baseUrl: string,
  email: string,
): string {
  return `${normalizeBeszelBaseUrl(baseUrl)}|${email.trim().toLowerCase()}`;
}
