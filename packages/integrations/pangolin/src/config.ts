/**
 * Adapter configuration for the Pangolin boundary: the base URL of the
 * Integration API (self-hosted, no fixed SaaS default — see the reachability
 * finding in `adapter.ts`'s module doc), the org this connection is bound to
 * (optional; several read methods still take an explicit `orgId` argument
 * because a root key can span every org on the instance), and the request
 * timeout. Nothing here reads `process.env`.
 *
 * `baseUrl` and `orgId` are non-secret connection configuration, not part of
 * the ADR-0019 `pangolin_credentials` bundle — see the bundle's own doc
 * comment in `@loxep/domain` for why (the same reasoning
 * `cloudflare_credentials`/`woo_credentials`/`medusa_credentials` already
 * apply: it must stay readable without a decryption round-trip, to render
 * the connection and to compute `pangolinSourceAccountKey`).
 */
import { z } from "zod";
import { PangolinAdapterError } from "./errors.ts";

export const PANGOLIN_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Rejects `http:` (never accepted — Pangolin instances are self-hosted, and
 * the API key travels as a bearer token that must never cross plaintext),
 * userinfo, a query string, and a fragment. Strips a trailing slash. Same
 * hygiene every adapter in this repo applies to a self-hosted base URL.
 */
export function normalizePangolinBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin base URL is not a valid absolute URL",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin base URL must use https",
      { protocol: parsed.protocol },
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin base URL must not embed credentials",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin base URL must not carry a query string or fragment",
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export const pangolinAdapterConfigSchema = z.object({
  baseUrl: z.string().min(1),
  orgId: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().positive().default(PANGOLIN_DEFAULT_TIMEOUT_MS),
});

export type PangolinAdapterConfigInput = z.input<typeof pangolinAdapterConfigSchema>;

export interface PangolinAdapterConfig {
  baseUrl: string;
  orgId: string | null;
  timeoutMs: number;
}

export function parsePangolinAdapterConfig(input: unknown): PangolinAdapterConfig {
  const result = pangolinAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new PangolinAdapterError(
      "invalid_request",
      `invalid Pangolin adapter config: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  return {
    baseUrl: normalizePangolinBaseUrl(result.data.baseUrl),
    orgId: result.data.orgId ?? null,
    timeoutMs: result.data.timeoutMs,
  };
}

/**
 * The stable key identifying "which Pangolin instance this connection
 * reads" — the normalized base URL alone. Unlike Tailscale's tailnet-scoped
 * key, no org is folded in here: one instance hosts many orgs behind one
 * base URL, and two connections against different orgs on the SAME instance
 * are still two connections to the same instance in the sense that matters
 * for dedup (same credential surface, same rate budget target).
 */
export function pangolinSourceAccountKey(baseUrl: string): string {
  return normalizePangolinBaseUrl(baseUrl);
}
