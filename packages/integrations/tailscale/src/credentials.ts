/**
 * Dev/test helper: load a local Tailscale credential env file (default
 * `~/.config/loxep/tailscale.env`). This is NOT a runtime configuration
 * path — production credentials live application-encrypted in PostgreSQL on
 * the provider connection (ADR-0016/ADR-0019). Nothing here is printed,
 * logged, or embedded in fixtures/errors.
 *
 * Tailscale documents two machine-usable auth models
 * (https://tailscale.com/docs/reference/tailscale-api,
 * https://tailscale.com/docs/features/oauth-clients — both verified
 * 2026-08-13):
 *
 * ## Mode 1 — a personal API access token
 *
 * *"Requests to the API are authenticated by using an access token
 * (sometimes called an API key), which can be generated from the Keys page
 * of the admin console... You need to be an Owner, Admin, IT admin, or
 * Network admin of a tailnet to generate an access token."* Sent as HTTP
 * Basic auth with the token as the username and an empty password
 * (`curl -u "tskey-api-xxxxx:"`, per the mirrored `api.md`).
 *
 * **OPERATIONAL IMPLICATION — this token EXPIRES.** *"You can choose the
 * number of days, between 1 and 90 inclusive, for the key expiry... If you
 * want to continue using an access token after this access token expires,
 * you need to generate a new access token."* There is no auto-renewal.
 * Loxep surfaces this as an ordinary `auth` adapter error when it happens —
 * the operator must return to the connection and paste a freshly generated
 * token, at most every 90 days.
 *
 * File format:
 * ```text
 *   TAILSCALE_API_ACCESS_TOKEN=tskey-api-...
 * ```
 *
 * ## Mode 2 — an OAuth client
 *
 * *"OAuth clients allow for ongoing access to the Tailscale API using the
 * client credentials flow [RFC 6749 §4.4]."* The client id/secret pair
 * itself does not carry Tailscale's 90-day access-token expiry; each
 * exchange at `POST /api/v2/oauth/token` mints an access token that *"expires
 * after one hour"* and this adapter re-exchanges automatically, so an
 * OAuth client is the better fit for unattended polling. Scope it to
 * `devices:core:read` (https://tailscale.com/kb/1623/trust-credentials-scopes
 * documents that read-suffixed variant of every scope family, including
 * device reads).
 *
 * File format:
 * ```text
 *   TAILSCALE_OAUTH_CLIENT_ID=k123456CNTRL
 *   TAILSCALE_OAUTH_CLIENT_SECRET=tskey-client-...
 * ```
 *
 * Exactly one mode's fields must be present; both together is a config
 * error caught here rather than left to the API to reject ambiguously.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TailscaleAdapterError } from "./errors.ts";

export type TailscaleCredentials =
  | { mode: "api_access_token"; apiAccessToken: string }
  | { mode: "oauth_client"; clientId: string; clientSecret: string };

export function defaultTailscaleEnvFilePath(): string {
  return join(homedir(), ".config", "loxep", "tailscale.env");
}

export function loadTailscaleCredentialsFromEnvFile(
  path: string = defaultTailscaleEnvFilePath(),
): TailscaleCredentials | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }

  const values = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match === null) {
      throw new TailscaleAdapterError(
        "invalid_request",
        `malformed line ${i + 1} in Tailscale env file`,
        { path, line: i + 1 },
      );
    }
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1] as string, value);
  }

  const nonEmpty = (key: string): string | undefined => {
    const value = values.get(key);
    return value !== undefined && value !== "" ? value : undefined;
  };

  const apiAccessToken = nonEmpty("TAILSCALE_API_ACCESS_TOKEN");
  const clientId = nonEmpty("TAILSCALE_OAUTH_CLIENT_ID");
  const clientSecret = nonEmpty("TAILSCALE_OAUTH_CLIENT_SECRET");

  const hasToken = apiAccessToken !== undefined;
  const hasOauth = clientId !== undefined || clientSecret !== undefined;

  if (hasToken && hasOauth) {
    throw new TailscaleAdapterError(
      "invalid_request",
      "Tailscale env file sets both an API access token and OAuth client fields; only one mode may be configured",
      { path },
    );
  }
  if (hasToken) {
    return { mode: "api_access_token", apiAccessToken };
  }
  if (clientId !== undefined && clientSecret !== undefined) {
    return { mode: "oauth_client", clientId, clientSecret };
  }
  throw new TailscaleAdapterError(
    "invalid_request",
    "Tailscale env file has neither a complete API access token nor a complete OAuth client pair",
    { path },
  );
}
