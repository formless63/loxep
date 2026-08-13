/**
 * Typed encrypted credential/secret bundles (ADR-0019).
 *
 * A plaintext payload is a typed structure validated per purpose BEFORE
 * encryption — an S3 credential atomically carries its access key ID and
 * secret access key. Validation failure messages carry issue paths and codes
 * only, never the offending values.
 */
import { z } from "zod";
import { BundleValidationError, UnknownPurposeError } from "./errors.ts";

export const secretBundleSchemas = {
  s3_credentials: z.strictObject({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  }),
  token: z.strictObject({
    token: z.string().min(1),
  }),
  smtp_password: z.strictObject({
    password: z.string().min(1),
  }),
  oauth_tokens: z.strictObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
  }),
  /**
   * eBay application keyset (ADR-0009): the developer-portal credentials one
   * Loxep installation uses to run the eBay OAuth consent flow and to sign
   * every provider call. Stored as the application secret
   * `integration.ebay.keyset`.
   *
   * `environment` and `ruName` are not themselves confidential, but they are
   * part of the atomic bundle on purpose: a sandbox keyset used against
   * production (or a RuName belonging to a different keyset) fails in ways
   * that look like credential corruption, and ADR-0019 bundles exist exactly
   * so a credential cannot be half-configured.
   */
  ebay_keyset: z.strictObject({
    appId: z.string().min(1),
    certId: z.string().min(1),
    devId: z.string().min(1),
    /** eBay "Redirect URL name"; required before user consent can run. */
    ruName: z.string().min(1).optional(),
    environment: z.enum(["sandbox", "production"]),
  }),
  /**
   * WooCommerce REST API key pair (ADR-0009): the consumer key and secret a
   * store issues for one integration. Sent as HTTP Basic Auth over HTTPS.
   *
   * The store URL is deliberately NOT part of this bundle, unlike
   * `ebay_keyset`'s `environment`/`ruName`. A base URL is non-secret
   * connection configuration that must stay readable without a decryption
   * round-trip (to render the connection, to run a health check, and to
   * compute the commerce design's `source_account_key`), and it carries none
   * of the half-configuration hazard that justifies bundling: a WooCommerce
   * key pair is issued by exactly one store, and pointing it at the wrong URL
   * fails as a clean HTTP 401 rather than as apparent credential corruption.
   */
  woo_credentials: z.strictObject({
    consumerKey: z.string().min(1),
    consumerSecret: z.string().min(1),
  }),
  /**
   * Medusa v2 Admin API secret key (ADR-0009): the single long-lived secret
   * token a Medusa backend issues for one integration, created once in the
   * admin dashboard (Settings → Developer → Secret API Keys). Sent as
   * `Authorization: Basic <apiToken>` — NOT base64("user:pass") the way
   * ordinary HTTP Basic auth works; the token itself (always prefixed
   * `sk_`) goes directly after `Basic `. See
   * `packages/integrations/medusa/src/config.ts` for the verified source
   * trail behind that wire format.
   *
   * Only one field, unlike `woo_credentials`'s key/secret pair — Medusa's
   * Admin API authenticates with a single secret token, so there is no
   * second part to keep atomic with it.
   *
   * The backend URL is deliberately NOT part of this bundle, for the same
   * reasoning `woo_credentials` excludes the store URL: it is non-secret
   * connection configuration that must stay readable without a decryption
   * round-trip (to render the connection, run a health check, and compute
   * the commerce design's `source_account_key`), and a Medusa secret key is
   * issued by exactly one backend — pointing it at the wrong URL fails as a
   * clean HTTP 401, not as apparent credential corruption.
   */
  medusa_credentials: z.strictObject({
    apiToken: z.string().min(1),
  }),
  /**
   * Invoice Ninja v5 company API token (ADR-0009): the single credential a
   * self-hosted Invoice Ninja instance issues per company/user pair
   * (Settings → Account Management → API Tokens), generated server-side as
   * `Str::random(64)` with no fixed prefix. Sent as `X-API-TOKEN: <apiToken>`
   * — no Basic/Bearer wrapping. See
   * `packages/integrations/invoiceninja/src/config.ts` for the verified
   * source trail behind that auth header.
   *
   * Only one field, matching `medusa_credentials`'s shape for the same
   * reason: Invoice Ninja's API authenticates with a single long-lived
   * token, so there is no second part to keep atomic with it.
   *
   * The instance URL is deliberately NOT part of this bundle, for the same
   * reasoning `medusa_credentials`/`woo_credentials` exclude their base
   * URLs: it is non-secret connection configuration that must stay readable
   * without a decryption round-trip (to render the connection, run a health
   * check, and compute the adapter's `invoiceNinjaSourceAccountKey`), and a
   * company token is issued by exactly one instance — pointing it at the
   * wrong URL fails as a clean HTTP 403 `{"message":"Invalid token"}`
   * (live-verified), not as apparent credential corruption.
   */
  invoiceninja_credentials: z.strictObject({
    apiToken: z.string().min(1),
  }),
  /**
   * Etsy application keyset (ADR-0009, loxep-g4t.1): the approved Developer
   * Portal app's credentials one Loxep installation uses to sign every Etsy
   * Open API v3 call (`x-api-key: <keystring>:<sharedSecret>`) and to run
   * the OAuth2+PKCE consent flow. Stored as the application secret
   * `integration.etsy.keyset`, the Etsy analogue of `ebay_keyset`.
   *
   * NEW rather than reused: eBay's `certId` plays a related role, but the
   * two bundle shapes differ enough (Etsy carries no environment/RuName —
   * it has no sandbox and no redirect-name indirection) that sharing a
   * schema would be a false economy, per the binding design
   * (`apps/docs/.../architecture/etsy-integration-design.md`, "Credential
   * bundle — app keyset + OAuth tokens, split like eBay's"). Unlike
   * `ebay_keyset`, there is no non-secret half worth bundling alongside it
   * (no environment, no redirect name) — both fields here are secret.
   */
  etsy_keyset: z.strictObject({
    keystring: z.string().min(1),
    sharedSecret: z.string().min(1),
  }),
  /**
   * Cloudflare API token (ADR-0009, loxep-lmy.1): the single credential the
   * Infrastructure control plane authenticates its own DNS calls with, sent as
   * `Authorization: Bearer <apiToken>`. Verified against
   * developers.cloudflare.com on 2026-08-13, including its troubleshooting
   * page's warning not to send a token with the legacy key syntax.
   *
   * **The legacy global API key is deliberately unsupported.** It carries every
   * permission on the account, cannot be scoped, and a control plane that edits
   * DNS has no business holding one. Only a scoped API token fits this bundle,
   * which is why the shape is `{ apiToken }` and not an email/key pair.
   *
   * Only one field, matching `medusa_credentials` and
   * `invoiceninja_credentials` for the same reason: there is no second part to
   * keep atomic with it.
   *
   * The **account identifier is deliberately NOT in this bundle**, for the same
   * reasoning that keeps a WooCommerce store URL and a Medusa backend URL out
   * of theirs: it is non-secret provider account identity that must stay
   * readable without a decryption round-trip (to render the connection, run a
   * health check, and compute `cloudflareSourceAccountKey`). The infrastructure
   * design says the same thing from the schema side — `managed_domains`
   * references the connection, "whose `config` carries the account
   * identifier".
   *
   * NAMING NOTE, recorded rather than drifted: the Phase 7 design's credential
   * table names this purpose `dns_provider_credentials`, one purpose shared by
   * every DNS provider. It is registered here under the PROVIDER name instead,
   * because that is what every sibling actually does (`woo_credentials`,
   * `medusa_credentials`, `invoiceninja_credentials`, `ebay_keyset`,
   * `etsy_keyset`) and because a second DNS provider will not necessarily
   * authenticate with a single bearer token — a role-named bundle would then
   * either fork or become a loose union, which is precisely the
   * half-configuration hazard ADR-0019 bundles exist to prevent. Flagged in the
   * design document's implementation-status header.
   *
   * This is the credential Loxep USES. The per-host tokens Loxep MINTS
   * (milestone 3) are a different class entirely: they live in
   * `application_secrets`, no Loxep adapter ever authenticates with them, and
   * they need their own purpose when that milestone ships.
   */
  cloudflare_credentials: z.strictObject({
    apiToken: z.string().min(1),
  }),
} as const;

export type SecretPurpose = keyof typeof secretBundleSchemas;

export type SecretBundle<P extends SecretPurpose> = z.infer<
  (typeof secretBundleSchemas)[P]
>;

/** Discriminated union of every purpose with its typed payload. */
export type SecretPayload = {
  [P in SecretPurpose]: { purpose: P; payload: SecretBundle<P> };
}[SecretPurpose];

export const secretPurposes = Object.keys(
  secretBundleSchemas,
) as SecretPurpose[];

export function isSecretPurpose(value: string): value is SecretPurpose {
  return Object.hasOwn(secretBundleSchemas, value);
}

/**
 * Validates a payload against its purpose bundle schema. Throws
 * {@link UnknownPurposeError} for unregistered purposes and
 * {@link BundleValidationError} (paths + codes only, no values) on schema
 * failure.
 */
export function validateBundle<P extends SecretPurpose>(
  purpose: P,
  payload: unknown,
): SecretBundle<P> {
  if (!isSecretPurpose(purpose)) {
    throw new UnknownPurposeError(
      `unknown secret purpose "${String(purpose)}" (registered: ${secretPurposes.join(", ")})`,
    );
  }
  const schema = secretBundleSchemas[purpose];
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    throw new BundleValidationError(
      `invalid "${purpose}" bundle: ${issues}`,
    );
  }
  return result.data as SecretBundle<P>;
}
