/**
 * Adapter configuration for the Termix boundary: the base URL of the
 * self-hosted instance and the request timeout. Nothing here reads
 * `process.env`.
 *
 * Termix is self-hosted, so there is no production base URL to default to
 * — the same posture Beszel and Dockhand take. `openapi.json`'s `servers`
 * array actually lists SEVEN internal service URLs
 * (`http://localhost:30001` for "Main database and authentication server"
 * through `http://localhost:30011` for "Serial connection server"), which
 * describes Termix's own multi-process backend layout, not a shape an
 * operator's Loxep connection should mirror — Termix's own install docs
 * front all of them behind one reverse-proxied port. `baseUrl` here is
 * therefore that single fronting origin, REQUIRED, and non-secret
 * connection configuration rather than part of the credential bundle — see
 * `termix_credentials` in `@loxep/domain`.
 */
import { z } from "zod";
import { TermixAdapterError } from "./errors.ts";

/** No sane default exists for a self-hosted instance; this is a doc example. */
export const TERMIX_EXAMPLE_BASE_URL = "http://localhost:8080";

export const TERMIX_DEFAULT_TIMEOUT_MS = 15_000;

/** Same userinfo/query/fragment hygiene every adapter in this repo applies. */
export function normalizeTermixBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TermixAdapterError(
      "invalid_request",
      "Termix base URL is not a valid absolute URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TermixAdapterError(
      "invalid_request",
      "Termix base URL must use http or https",
      { protocol: parsed.protocol },
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TermixAdapterError(
      "invalid_request",
      "Termix base URL must not embed credentials; store them on the connection",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TermixAdapterError(
      "invalid_request",
      "Termix base URL must not carry a query string or fragment",
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export const termixAdapterConfigSchema = z.object({
  baseUrl: z.string().min(1),
  timeoutMs: z.number().int().positive().default(TERMIX_DEFAULT_TIMEOUT_MS),
});

export type TermixAdapterConfigInput = z.input<typeof termixAdapterConfigSchema>;

export interface TermixAdapterConfig {
  baseUrl: string;
  timeoutMs: number;
}

export function parseTermixAdapterConfig(input: unknown): TermixAdapterConfig {
  const result = termixAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new TermixAdapterError(
      "invalid_request",
      `invalid Termix adapter config: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  return {
    baseUrl: normalizeTermixBaseUrl(result.data.baseUrl),
    timeoutMs: result.data.timeoutMs,
  };
}

/**
 * The stable key identifying "which Termix account this connection speaks
 * as" — composed of the normalized base URL and the username, the same
 * shape Dockhand's `dockhandSourceAccountKey` uses for the same reason: two
 * Loxep connections against one Termix instance with different accounts
 * genuinely see different hosts and sessions.
 */
export function termixSourceAccountKey(
  baseUrl: string,
  username: string,
): string {
  return `${normalizeTermixBaseUrl(baseUrl)}|${username.trim().toLowerCase()}`;
}
