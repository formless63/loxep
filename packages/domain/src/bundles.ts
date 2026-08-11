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
