/**
 * Every Tailscale path this adapter may build, in one place, so the boundary
 * test can enumerate the surface and prove what is absent.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner-supplied primary source, https://tailscale.com/docs/reference/tailscale-api,
 * now reads only *"The Tailscale API documentation has moved to
 * https://tailscale.com/api"* — an interactive, JavaScript-rendered OpenAPI
 * explorer this environment cannot fetch as text. The literal paths and
 * fields below are therefore corroborated from three secondary artifacts
 * that all describe the SAME api.tailscale.com surface:
 *
 * - the mirrored historical `api.md` (before the interactive-docs move) at
 *   https://gitea.codinget.me/webnet/tailscale/src/commit/41db1d7bba31ab3667187871dc48e220bb7a77f4/api.md,
 *   which shows the literal `GET /api/v2/tailnet/{tailnet}/devices` request,
 *   its `fields` query parameter (`all` | `default`), the `-` tailnet
 *   shorthand ("Provide a dash (`-`) to reference the default tailnet of the
 *   access token being used to make the API call. This is the best option
 *   for most users."), and the `{"message": "..."}` error envelope;
 * - Tailscale's own maintained Go client, `tailscale.com/client/tailscale/v2`
 *   (https://pkg.go.dev/tailscale.com/client/tailscale/v2), whose
 *   `DevicesResource.List`/`Get` godoc names the same paths and whose
 *   `Device` struct is the JSON shape this module reads;
 * - https://tailscale.com/docs/features/oauth-clients for the OAuth
 *   client-credentials flow.
 *
 * `test/live-tailscale.test.ts` is the standing job to confirm all of this
 * against a real tailnet.
 *
 * ## Read-only by construction
 *
 * The `devices:core` OAuth scope alone "grants access to read AND WRITE the
 * list of devices in the tailnet, authorize or remove machines, and
 * manipulate tags" — Tailscale does not publish a device-mutation-free scope
 * narrower than that. Loxep's restraint is therefore enforced entirely in
 * this adapter's own exported surface (no member starts with a write verb)
 * and in {@link TAILSCALE_ALLOWED_PATH_PREFIXES}, never assumed from the
 * credential. `test/boundary.test.ts` asserts every request the adapter
 * makes is a `GET`, with the sole exception of the OAuth token exchange.
 */

/** SaaS default. Verified via the Go client's `Client.BaseURL` doc default. */
export const TAILSCALE_API_PREFIX = "/api/v2";

/**
 * `-` references "the default tailnet of the access token being used to make
 * the API call" (api.md, quoted in the module doc) — the sane default so an
 * operator need not discover their tailnet's literal name.
 */
export const TAILSCALE_DEFAULT_TAILNET = "-";

export function tailscaleDevicesPath(tailnet: string): string {
  return `${TAILSCALE_API_PREFIX}/tailnet/${encodeURIComponent(tailnet)}/devices`;
}

export function tailscaleDevicePath(deviceId: string): string {
  return `${TAILSCALE_API_PREFIX}/device/${encodeURIComponent(deviceId)}`;
}

/** `POST` — the OAuth client_credentials token exchange. */
export const TAILSCALE_OAUTH_TOKEN_PATH = `${TAILSCALE_API_PREFIX}/oauth/token`;

/** The path prefixes this adapter may ever request. */
export const TAILSCALE_ALLOWED_PATH_PREFIXES = [
  `${TAILSCALE_API_PREFIX}/tailnet/`,
  `${TAILSCALE_API_PREFIX}/device/`,
  TAILSCALE_OAUTH_TOKEN_PATH,
] as const;

/** The only path reachable with a method other than `GET`. */
export const TAILSCALE_ALLOWED_NON_GET_PATHS = [
  TAILSCALE_OAUTH_TOKEN_PATH,
] as const;
