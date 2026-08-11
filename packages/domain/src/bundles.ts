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
