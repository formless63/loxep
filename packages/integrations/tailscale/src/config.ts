/**
 * Adapter configuration for the Tailscale boundary: the tailnet to read, the
 * base URL of the control API (fixed SaaS default, overridable for
 * enterprise/self-hosted-control-plane deployments), and the request
 * timeout. Nothing here reads `process.env`.
 *
 * Both `tailnet` and `baseUrl` are non-secret connection configuration, not
 * part of the ADR-0019 credential bundle — see `tailscale_credentials` in
 * `@loxep/domain`.
 */
import { z } from "zod";
import { TailscaleAdapterError } from "./errors.ts";
import { TAILSCALE_DEFAULT_TAILNET } from "./operations.ts";

/** Verified via the Go client's `Client.BaseURL` doc default. */
export const TAILSCALE_DEFAULT_BASE_URL = "https://api.tailscale.com";

export const TAILSCALE_DEFAULT_TIMEOUT_MS = 15_000;

/** Same userinfo/query/fragment hygiene every adapter in this repo applies. */
export function normalizeTailscaleBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TailscaleAdapterError(
      "invalid_request",
      "Tailscale base URL is not a valid absolute URL",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new TailscaleAdapterError(
      "invalid_request",
      "Tailscale base URL must use https",
      { protocol: parsed.protocol },
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TailscaleAdapterError(
      "invalid_request",
      "Tailscale base URL must not embed credentials",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TailscaleAdapterError(
      "invalid_request",
      "Tailscale base URL must not carry a query string or fragment",
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export const tailscaleAdapterConfigSchema = z.object({
  tailnet: z.string().min(1).default(TAILSCALE_DEFAULT_TAILNET),
  baseUrl: z.string().min(1).default(TAILSCALE_DEFAULT_BASE_URL),
  timeoutMs: z.number().int().positive().default(TAILSCALE_DEFAULT_TIMEOUT_MS),
});

export type TailscaleAdapterConfigInput = z.input<
  typeof tailscaleAdapterConfigSchema
>;

export interface TailscaleAdapterConfig {
  tailnet: string;
  baseUrl: string;
  timeoutMs: number;
}

export function parseTailscaleAdapterConfig(
  input: unknown,
): TailscaleAdapterConfig {
  const result = tailscaleAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new TailscaleAdapterError(
      "invalid_request",
      `invalid Tailscale adapter config: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  return {
    tailnet: result.data.tailnet,
    baseUrl: normalizeTailscaleBaseUrl(result.data.baseUrl),
    timeoutMs: result.data.timeoutMs,
  };
}

/**
 * The stable key identifying "which Tailscale tailnet this connection
 * reads", used to detect two connections pointed at the same tailnet.
 *
 * Composed of the normalized base URL and the tailnet name. `-` (the
 * "default tailnet of the token" shorthand) is deliberately NOT resolved to
 * a literal name here — that resolution would need a live call, and this
 * function must stay pure. Two connections that both configure `tailnet: -`
 * therefore collide on this key even if their tokens belong to different
 * tailnets; each connection should be given its literal tailnet name once
 * known, exactly as Beszel's `email` disambiguates two readonly users on one
 * hub.
 */
export function tailscaleSourceAccountKey(
  baseUrl: string,
  tailnet: string,
): string {
  return `${normalizeTailscaleBaseUrl(baseUrl)}|${tailnet.trim().toLowerCase()}`;
}
