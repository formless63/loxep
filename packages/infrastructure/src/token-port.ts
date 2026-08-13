/**
 * The DNS-token provider port: the shapes `tokens.ts` needs from a DNS
 * adapter to mint, scope, and roll a per-host DNS-edit credential (Phase 7
 * milestone 3, loxep-lmy.3), **re-declared structurally rather than
 * imported** — the same discipline `port.ts` applies to zone/record reads and
 * `mail-port.ts` applies to mail.
 *
 * `@loxep/infrastructure` takes NO dependency on
 * `@loxep/integration-cloudflare`. The composition root holds the adapter and
 * passes a port implementation in; this package's tests run against a stub
 * with no provider code in the graph at all.
 *
 * ## Why this is a SEPARATE port from {@link DnsProviderPort}
 *
 * Reading and writing DNS records is the everyday reconcile path every
 * domain's sync exercises. Minting a credential is a rare, high-consequence
 * admin action with a completely different failure shape — its one
 * non-repeatable output is a secret — and folding it into the same interface
 * would make every DNS adapter implement token minting whether or not the
 * connection is ever used to mint one. The two capabilities are provided by
 * the same Cloudflare-class adapter in practice, but nothing here assumes
 * that: a DNS provider with no token-minting API simply has no
 * {@link DnsTokenProviderPort} implementation, and the composition root leaves
 * the fleet UI's mint action disabled for that connection.
 *
 * ## The value is returned EXACTLY ONCE — a provider behavior, not a Loxep
 * choice
 *
 * `mintToken` and `rollToken` are the only two members of this port that ever
 * see a token's plaintext value, and each is called from exactly one place:
 * the request-scoped admin action in `tokens.ts`. Neither may be called from
 * a worker job — see that module's header for the HARD CONSTRAINT this port
 * exists to make possible to honor.
 *
 * ## A policy update REPLACES the whole array
 *
 * There is no provider call to add one zone to an existing token's scope.
 * `updatePolicy` therefore always receives the COMPLETE desired zone set, and
 * an adapter that tried to diff against the provider's current policy would
 * be doing extra, pointless work — the caller already computed the set from
 * `dns_provider_token_zones`, which is intent, not a mirror.
 */
import type { LoxepDb } from "@loxep/db";

/** What the mint call needs to produce a scoped, named token. */
export interface DnsTokenMintInput {
  /** A human-legible label. Shown at the provider dashboard, not secret. */
  name: string;
  /** Loxep's own label; see {@link DnsProviderTokenScope} in the schema. */
  permissionScope: "dns_edit";
  /** The provider's own zone identifiers to scope the token to, INITIALLY. */
  zoneExternalIds: readonly string[];
}

/** What a successful mint returns. `value` is returned EXACTLY ONCE. */
export interface DnsTokenMintResult {
  externalTokenId: string;
  /** The plaintext token value. Never logged, never persisted verbatim by the adapter. */
  value: string;
}

/** What a successful roll returns — a NEW value for the SAME external token. */
export interface DnsTokenRollResult {
  value: string;
}

/**
 * The minimal contract that makes token minting, scoping, and rolling
 * provider-agnostic.
 *
 * `findTokenById` is a READ-BACK member, structurally mirroring
 * `DnsProviderPort.findZoneByName` and `MailProviderPort.findDomainByName`:
 * it exists so a `pending` `provider_operations` row COULD be reconciled by
 * reading the provider back. Per design open question 4, a token create is
 * the one case that read-back cannot resolve — the value is returned exactly
 * once and a re-read of the token's metadata does not recover it — so
 * `tokens.ts` uses this member only to confirm existence, never to recover a
 * lost value, and resolves an ambiguous mint to "assume created, value lost,
 * roll it" exactly as the design says.
 */
export interface DnsTokenProviderPort {
  /** Mint a new token. NON-IDEMPOTENT: the value is returned exactly once. */
  mintToken(input: DnsTokenMintInput): Promise<DnsTokenMintResult>;
  /** Roll (regenerate) an existing token's value. Also NON-IDEMPOTENT. */
  rollToken(externalTokenId: string): Promise<DnsTokenRollResult>;
  /** Replace the token's ENTIRE zone policy with this set. Idempotent. */
  updatePolicy(
    externalTokenId: string,
    zoneExternalIds: readonly string[],
  ): Promise<void>;
  /** Read-back: does the provider still show this token as existing. */
  findTokenById(externalTokenId: string): Promise<{ exists: boolean }>;
}

/**
 * The write-only half of `@loxep/domain`'s secrets service, re-declared
 * structurally so this package needs neither the keyring nor the full service
 * type — the same shape `MailboxSecretWriter` uses in `mail-port.ts`.
 *
 * **There is deliberately no read member.** `tokens.ts` never needs one: the
 * plaintext it writes here is the SAME value it already holds locally and is
 * about to return to its caller once. Reading it back later is exactly what
 * ADR-0022 clause 2 forbids, and the absence of a read member here is what
 * keeps a future edit from adding a read-back without first widening this
 * interface — a visible change.
 *
 * ## Why this takes a TRANSACTION HANDLE as its first argument
 *
 * This is the one place in the whole design where a failed transaction has a
 * real external cost: the provider has already returned a value that will
 * never be returned again. The design's instruction is exact — *"the value
 * must be captured into an application_secrets version in the SAME
 * transaction that writes the token row, or it is unrecoverable."*
 * `@loxep/domain`'s real `SecretsService.setSecret` opens its own internal
 * `db.transaction(...)`; passed a transaction handle rather than a pool, that
 * becomes a SAVEPOINT nested inside the caller's transaction, so a rollback
 * of the outer transaction rolls back the secret write too. This is the exact
 * shape `TransactionalEnqueue` (`domains.ts`) uses for the same reason: the
 * way to lose the atomicity guarantee silently is to call this function with
 * a pool client instead of the transaction handle it was given.
 */
export type TransactionalDnsTokenSecretWriter = (
  tx: LoxepDb,
  input: {
    secretKey: string;
    purpose: "dns_edit_token";
    payload: { token: string };
    actorUserId?: string | null;
  },
) => Promise<{ id: string }>;
