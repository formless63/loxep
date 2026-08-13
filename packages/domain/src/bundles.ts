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
  /**
   * Purelymail API token (ADR-0009, loxep-lmy.2): the single credential the
   * Infrastructure control plane authenticates every mail-hosting call with,
   * sent as `Purelymail-Api-Token: <apiToken>`. Verified against the provider's
   * published OpenAPI document (`components.securitySchemes.token`, an `apiKey`
   * in a header) and against the live API on 2026-08-13 — an unauthenticated
   * call answers with a message naming the header itself.
   *
   * Only one field, matching `cloudflare_credentials`, `medusa_credentials`,
   * and `invoiceninja_credentials`: there is no second part to keep atomic
   * with it.
   *
   * **There is no non-secret half to leave out**, unlike every sibling. A
   * WooCommerce store URL, a Medusa backend URL, and a Cloudflare account id
   * are each excluded from their bundles because they must stay readable
   * without a decryption round-trip. Purelymail exposes **no account identifier
   * at all** — the token IS the account, and no endpoint takes or returns an
   * account id — so `connections.config` carries nothing for this provider and
   * the source-account key derives from the base URL alone. The consequence is
   * worth stating: two Purelymail connections against the same host produce the
   * same source-account key, so the connection id remains the only
   * discriminator between them.
   *
   * NAMING NOTE: the Phase 7 design's credential table names this purpose
   * `mail_provider_credentials`, one purpose shared by every mail provider. It
   * is registered under the PROVIDER name instead, for the reason recorded in
   * `cloudflare_credentials` above and endorsed by the design's own
   * implementation note — *"milestones 2 and 3 should follow the provider-named
   * form too"*.
   */
  purelymail_credentials: z.strictObject({
    apiToken: z.string().min(1),
  }),
  /**
   * A generated mailbox password (ADR-0019, loxep-lmy.2), stored as the
   * application secret `infrastructure.mailbox.<mailboxes.id>` and referenced
   * by `mailboxes.secret_id`.
   *
   * **This is a credential Loxep MINTS, not one it consumes.** No Loxep adapter
   * ever authenticates with it; it is generated, handed to the mail provider
   * once at mailbox creation, and stored. That is the same class as the
   * milestone-3 per-host DNS token and a different class from every other
   * purpose in this registry, which is why it is an `application_secrets` row
   * rather than a `connection_credentials` one — the design's split criterion:
   * *"an application secret is for encrypted material that is not naturally the
   * credential of one provider connection"*.
   *
   * ## WRITE-ONLY, and ADR-0022 is why that is the FINISHED state here
   *
   * Nothing reads this secret back. There is no reveal server function, route,
   * or UI, and no read member on the port the reconciler writes through.
   *
   * ADR-0022 (PROVISIONAL) resolved the design's open question 1 —
   * *"reveal-once at mint time; write-only forever after"*: plaintext may be
   * shown to the requesting admin **exactly once, in the response to the
   * creating action**, and after that response completes no read-back path
   * exists for anyone.
   *
   * **That one-time channel is structurally unavailable to this milestone, and
   * the reason is worth stating rather than discovering.** Loxep mints a
   * mailbox password inside `infrastructure.sync-mailboxes`, a Graphile Worker
   * job. There is no requesting admin, no response, and no tab to show a value
   * in — the mint happens minutes or days after the operator declared the
   * mailbox, whenever delegation and ownership verification finally complete.
   * So clause 1 has nothing to fire into and clause 2 applies from birth: this
   * value is write-only, and a lost one is a ROTATION (ADR-0022 clause 4),
   * never a recovery.
   *
   * A milestone-3 UI that wants the one-time reveal must therefore move the
   * mint into a request-scoped admin action rather than adding a read-back to
   * this purpose — reading a stored value later is precisely what clause 2
   * forbids, and the distinction is easy to lose.
   *
   * Distinct from `smtp_password`, which is a credential Loxep USES to send
   * mail through someone else's server. Sharing the schema would have merged a
   * consumed credential with a minted one, and the reveal exception — if it
   * ever lands — must not widen to consumed credentials by accident. That is
   * precisely the widening the design's recommendation warns against.
   */
  mailbox_password: z.strictObject({
    password: z.string().min(1),
  }),
  /**
   * A minted per-host DNS-edit token (ADR-0019, loxep-lmy.3), stored as the
   * application secret `infrastructure.dns_token.<dns_provider_tokens.id>`
   * and referenced by `dns_provider_tokens.secret_id`.
   *
   * **This is a credential Loxep MINTS, not one it consumes** — the same
   * class as `mailbox_password` above and the design's own contrast: *"the
   * credentials Loxep USES live in `connections`/`connection_credentials`;
   * the credentials Loxep MINTS live in `application_secrets`, and no Loxep
   * adapter ever authenticates with them."* A per-host token exists so a
   * process on THAT host can edit its own DNS zones directly; Loxep's own DNS
   * calls authenticate with `cloudflare_credentials`, never with this.
   *
   * ## Reveal-once, and this purpose is where ADR-0022's job-mint gap gets
   * closed
   *
   * `mailbox_password` above is write-only from birth because its mint runs
   * inside a Graphile Worker job with no admin waiting on it — ADR-0022's
   * clause 1 has nothing to fire into there. This purpose is different BY
   * CONSTRUCTION: milestone 3's mint is a request-scoped admin server action
   * (`mintDnsProviderToken` in `@loxep/infrastructure`'s `tokens.ts`) that
   * returns the plaintext in its own response, exactly once, before the
   * caller ever sees the stored row. After that response, this value is
   * write-only forever — no server function, route, or UI reads it back — and
   * a lost value is a ROTATION (ADR-0022 clause 4), never a recovery.
   *
   * The `/infrastructure` fleet UI must present the mint response as the
   * one-time reveal (copy button, "you will not see this again") and must
   * never offer a control that looks like it re-fetches this value — reading
   * a stored secret back later is precisely what ADR-0022 clause 2 forbids,
   * and the two produce identical pixels.
   */
  dns_edit_token: z.strictObject({
    token: z.string().min(1),
  }),
  /**
   * A Beszel hub login (ADR-0019, loxep-9j6): the credential
   * `@loxep/integration-beszel` exchanges for a PocketBase auth token before
   * every read of the fleet's system status.
   *
   * ## Two fields, because Beszel has no API token at all
   *
   * Every sibling in this registry that carries one field does so because the
   * provider issues a long-lived key. Beszel issues none. Its hub *"is built on
   * PocketBase"* and the documented way in is PocketBase's password exchange
   * (`POST /api/collections/users/auth-with-password`), which returns a
   * short-lived JWT. The email and the password are useless apart and must
   * rotate together, which is exactly the atomicity ADR-0019 bundles exist for.
   *
   * ## This is a READONLY user, not a superuser — a correction, recorded
   *
   * The fleet-observability design gated Beszel at tier 3 on the claim that
   * *"a read consumer needs a superuser credential… there is no scoped
   * read-only token"*, and made the owner's approval conditional on accepting
   * fleet-wide administrative access in Loxep's database.
   *
   * **That claim was wrong, and upstream's own documentation says so.** Beszel
   * publishes three roles in the ordinary `users` collection, the lowest of
   * which is exactly the shape this bundle wants: *"Read-only users cannot
   * create systems but can view any system shared with them by an admin and
   * create alerts."* Upstream also states that *"regular user accounts and
   * PocketBase superuser accounts are entirely separate"* and that *"changing a
   * user's role to admin does not create a superuser account"* — so the
   * `users` collection and the `_superusers` collection are different
   * credentials, and the REST guide's own first example authenticates *"as
   * regular user"*.
   *
   * The consequence is the one that matters for consent: the credential Loxep
   * stores is a purpose-made readonly account that can see only the systems an
   * admin deliberately shared with it. A Loxep database compromise plus keyring
   * access therefore yields *a view of the shared subset of the fleet*, not
   * administrative control of the monitoring hub. The bundle is named for the
   * connection, and the connection form must say "Beszel readonly user" —
   * calling it an "API token" would be the small dishonesty the design already
   * warned about, in the opposite direction.
   *
   * The **base URL is deliberately NOT in this bundle**, matching every sibling:
   * it is non-secret provider identity that must stay readable without a
   * decryption round-trip, so it lives in `connections.config`.
   */
  beszel_credentials: z.strictObject({
    /** PocketBase calls this field `identity`; Beszel's accounts are emails. */
    email: z.string().min(1),
    password: z.string().min(1),
  }),
  /**
   * A Dockhand login (ADR-0019, loxep-9j6): the credential
   * `@loxep/integration-dockhand` exchanges at `POST /api/auth/login` for the
   * session cookie every subsequent call carries.
   *
   * ## Two fields, because Dockhand has no bearer path
   *
   * Dockhand's API reference documents exactly one machine-usable
   * authentication mode: *"HTTP-only session cookies"*, sent back as
   * `Cookie: session=…`, obtained from `POST /api/auth/login`. There is no API
   * key, personal access token, or service account anywhere in its published
   * authentication documentation.
   *
   * That resolves — in the API reference's favour — the fleet-observability
   * design's complaint that Dockhand had *"contradictory auth documentation"*
   * describing session cookies in one place and API tokens in another. The
   * published API reference is not contradictory: it is session-cookie only.
   * The adapter therefore holds a login, not a key, and re-logs-in when the
   * cookie expires (upstream default: seven days).
   *
   * ## The privilege this credential should carry
   *
   * Dockhand gates its endpoints on named permissions — `environments:view`,
   * `environments:edit`, `stacks:view` are the four this integration touches.
   * The account stored here needs those and nothing else. It must **not** be
   * the operator's own admin account, because the same session that reads a
   * container list can, at Dockhand's own API, start and stop containers: the
   * restraint that keeps Loxep on the right side of
   * [rule 13](../../architecture/domain-boundaries/) is enforced in Loxep's
   * adapter surface, not by Dockhand's session.
   *
   * The **base URL is deliberately NOT in this bundle**, for the same reason as
   * every sibling: `connections.config` carries it.
   */
  dockhand_credentials: z.strictObject({
    /** Dockhand rate-limits login by IP/username pair; this is that username. */
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  /**
   * Reverb Personal Access Token (ADR-0009, loxep-g4t.3): the single
   * credential `@loxep/integration-reverb` authenticates every call with,
   * sent as `Authorization: Bearer <personalAccessToken>`. Verified against
   * Reverb's own developer documentation
   * (https://www.reverb-api.com/docs/authentication, fetched 2026-08-13):
   * "Reverb Personal Access Tokens do not expire" and are minted by the
   * account owner, self-service, with no approval queue — the simplest
   * auth model of any marketplace in the catalog.
   *
   * Only one field, matching `medusa_credentials`/`invoiceninja_credentials`/
   * `cloudflare_credentials`/`purelymail_credentials`: there is no second
   * part to keep atomic with it. UNLIKE Etsy's `etsy_keyset`, there is no
   * separate application-level credential at all — Reverb has no
   * installation-wide keyset; each connection's PAT is minted independently
   * from its own Reverb account.
   *
   * **There is no non-secret half to leave out**, the same as
   * `purelymail_credentials`: Reverb has no per-deployment base URL (one
   * fixed hosted API) and m1's `reverb_shop` monitor target observes the
   * token owner's own account implicitly, so no shop identifier needs to be
   * typed in at connect time either — see
   * `packages/integrations/reverb/src/connection.ts` for the full contract,
   * including the `source_account_key` divergence this implies.
   */
  reverb_credentials: z.strictObject({
    personalAccessToken: z.string().min(1),
  }),
  /**
   * Tailscale API credential (ADR-0009, loxep-4su): what
   * `@loxep/integration-tailscale` authenticates every tailnet-devices read
   * with. Verified against https://tailscale.com/docs/reference/tailscale-api,
   * https://tailscale.com/docs/features/oauth-clients, and Tailscale's own
   * maintained Go client (2026-08-13).
   *
   * ## Two modes, because Tailscale documents two, and neither subsumes the other
   *
   * A personal **API access token**, sent as HTTP Basic auth with the token
   * as username and an empty password — simplest to set up, but it
   * *"expires after"* an operator-chosen *"1 and 90"* days with no
   * auto-renewal, so unattended polling eventually needs a human to paste a
   * fresh one. Or an **OAuth client** (`client_id` + `client_secret`, RFC
   * 6749 §4.4 client-credentials) — the pair itself does not carry that
   * fixed expiry, and this adapter re-exchanges the short-lived (*"one
   * hour"*) minted access token automatically, which is the better fit for
   * unattended polling. Loxep supports both rather than picking one,
   * because each is the DOCUMENTED way in and an operator may already have
   * standardized on one or the other.
   *
   * `mode` is the discriminant so a bundle is never half of one shape and
   * half of the other.
   *
   * The **tailnet name and base URL are deliberately NOT in this bundle**,
   * matching every sibling: non-secret provider identity/config belongs in
   * `connections.config`, readable without a decryption round-trip — see
   * `tailscaleSourceAccountKey` in `@loxep/integration-tailscale`.
   */
  tailscale_credentials: z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("api_access_token"),
      apiAccessToken: z.string().min(1),
    }),
    z.strictObject({
      mode: z.literal("oauth_client"),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
    }),
  ]),
  /**
   * A Termix login (ADR-0009, loxep-g3f): the username/password
   * `@loxep/integration-termix` exchanges at `POST /users/login` for a JWT,
   * per Termix's own published OpenAPI document (`Termix-SSH/Docs`,
   * `static/openapi.json`, verified 2026-08-13).
   *
   * ## Two fields, because Termix has no scoped API token
   *
   * Every sibling that carries one field does so because the provider
   * issues a long-lived key. Termix issues none — its spec documents an
   * ordinary username/password login and no per-integration read-only
   * account concept (unlike Beszel's `readonly` role). The account stored
   * here is therefore a real Termix user; Loxep's restraint against
   * Termix's much larger write surface (Docker control, systemd services,
   * process signals, terminal exec, file deletion) is enforced entirely in
   * the adapter's own exported surface, not by anything this login grants
   * or withholds — the same posture `dockhand_credentials` documents for
   * the same reason, at smaller scale.
   *
   * The **base URL is deliberately NOT in this bundle**, for the same
   * reason as every self-hosted sibling: `connections.config` carries it.
   */
  termix_credentials: z.strictObject({
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  /**
   * A Gatus Basic-auth credential (ADR-0009, loxep-ovj.4): what
   * `@loxep/integration-gatus` sends as `Authorization: Basic
   * base64(username:password)` when the operator's instance is
   * Basic-secured. Verified against `github.com/TwiN/gatus` v5.36.0's own Go
   * source (`security/config.go`'s `ApplySecurityMiddleware`, which wires
   * `fiber`'s ordinary `basicauth` middleware) — gatus.io/docs is a
   * client-rendered SPA and unusable as a reference.
   *
   * ## An OPTIONAL pair — unlike every other login-shaped bundle here
   *
   * Every sibling that carries a username/password pair
   * (`beszel_credentials`, `dockhand_credentials`, `termix_credentials`)
   * requires it, because those providers are always behind a login. Gatus is
   * not: the fleet-observability design's verdict table states *"the API is
   * fully open when no `security` block is configured"*, and even when
   * `security.oidc` is configured there is no bearer credential a
   * server-to-server reader could hold at all (`security/oidc.go` — a
   * browser-redirect session cookie, never a header a background job can
   * present). Both of those are legitimate, common Gatus deployments with
   * NOTHING for this bundle to hold, so `username`/`password` are optional —
   * present together, per the atomicity every bundle here enforces, or
   * absent together. `@loxep/integration-gatus`'s adapter probes
   * `GET /api/v1/config` at read time to learn which of the three states
   * (open / Basic / OIDC) applies and never assumes a credential exists.
   *
   * The **base URL is deliberately NOT in this bundle**, matching every
   * self-hosted sibling: `connections.config` carries it, so it stays
   * readable without a decryption round-trip.
   */
  gatus_credentials: z
    .strictObject({
      username: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
    })
    .refine((value) => (value.username === undefined) === (value.password === undefined), {
      message: "username and password must be provided together, or neither",
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
