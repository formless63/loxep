/**
 * Adapter configuration for the Dockhand boundary: the base URL of the hub, the
 * request timeout, and the derived source-account key.
 *
 * Dockhand is **self-hosted**, so unlike Cloudflare or Purelymail there is no
 * production base URL to default to. Its API overview gives both forms —
 * *"`http://your-dockhand-instance:3000/api` or
 * `https://your-dockhand-instance.com/api` for production"*
 * (https://finsys-dockhand.mintlify.app/api/overview) — so the operator's
 * instance could be a LAN address on port 3000 or a TLS reverse proxy. The base
 * URL is therefore REQUIRED, and it is non-secret connection config rather than
 * part of the credential bundle — see `dockhand_credentials` in `@loxep/domain`.
 *
 * **The base URL stops before `/api`.** Upstream writes its base with the
 * prefix included; this module stores the ORIGIN and lets `operations.ts` own
 * the `/api` prefix, so that the one place the unversioned prefix is written
 * down is the one place a future versioned prefix would have to change. A URL
 * pasted with a trailing `/api` is therefore normalized by stripping it, rather
 * than silently producing `/api/api/environments`.
 */
import { z } from "zod";
import { DockhandAdapterError } from "./errors.ts";

/** No sane default exists for a self-hosted instance; this is a doc example. */
export const DOCKHAND_EXAMPLE_BASE_URL = "http://localhost:3000";

export const DOCKHAND_DEFAULT_TIMEOUT_MS = 15_000;

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
export function normalizeDockhandBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new DockhandAdapterError(
      "invalid_request",
      "Dockhand base URL is not a valid absolute URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DockhandAdapterError(
      "invalid_request",
      "Dockhand base URL must use http or https",
      { protocol: parsed.protocol },
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new DockhandAdapterError(
      "invalid_request",
      "Dockhand base URL must not embed credentials; store them on the connection",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new DockhandAdapterError(
      "invalid_request",
      "Dockhand base URL must not carry a query string or fragment",
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${parsed.origin}${path}`;
}

export const dockhandAdapterConfigSchema = z.object({
  baseUrl: z.string().min(1),
  timeoutMs: z.number().int().positive().default(DOCKHAND_DEFAULT_TIMEOUT_MS),
});

export type DockhandAdapterConfigInput = z.input<typeof dockhandAdapterConfigSchema>;

export interface DockhandAdapterConfig {
  baseUrl: string;
  timeoutMs: number;
}

export function parseDockhandAdapterConfig(
  input: unknown,
): DockhandAdapterConfig {
  const result = dockhandAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new DockhandAdapterError(
      "invalid_request",
      `invalid Dockhand adapter config: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  return {
    baseUrl: normalizeDockhandBaseUrl(result.data.baseUrl),
    timeoutMs: result.data.timeoutMs,
  };
}

/**
 * The stable key identifying "which Dockhand account this connection speaks as",
 * used to detect two connections pointed at the same instance.
 *
 * Composed of the normalized base URL **and** the username, because Dockhand's
 * permissions are per user (`environments:view`, `environments:edit`,
 * `containers:view`, `stacks:view`) and two Loxep connections against one
 * instance with different accounts genuinely see different things — unlike
 * Purelymail, where the token IS the account and the base URL alone had to
 * serve. The username is non-secret identity that is already in the bundle; it
 * is lower-cased so `Ops` and `ops` do not look like two accounts.
 */
export function dockhandSourceAccountKey(
  baseUrl: string,
  username: string,
): string {
  return `${normalizeDockhandBaseUrl(baseUrl)}|${username.trim().toLowerCase()}`;
}
