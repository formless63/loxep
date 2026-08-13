/**
 * The mail provider port: the shapes this domain needs from a mail adapter,
 * **re-declared structurally rather than imported** — the same discipline
 * `port.ts` applies to DNS.
 *
 * `@loxep/infrastructure` takes NO dependency on
 * `@loxep/integration-purelymail`, exactly as it takes none on
 * `@loxep/integration-cloudflare`. The composition root holds both and passes
 * adapters in. The consequence is the intended one: a second mail provider
 * needs a new integration package and no change here, and this package's tests
 * run against a stub with no provider code in the graph at all.
 *
 * The duplication is guarded the way every other structural re-declaration in
 * Loxep is — by a compile-time assignability test in the composition root's
 * suite, so a drift between the two shapes fails a test rather than a
 * production sync.
 *
 * ## What is deliberately NOT in this port
 *
 * - **No ownership-verified boolean.** The provider has no such field, and
 *   inventing one here would put an interpretation in the port instead of in
 *   the domain service where it can be reasoned about. What the port exposes is
 *   what a provider can actually answer: is the domain present, and what does
 *   the provider's own DNS check say.
 * - **No password generation.** The minter is a separate injected seam
 *   ({@link PasswordMinter}) because it is a Loxep concern, not a provider one,
 *   and because a test must be able to make it deterministic without stubbing
 *   an adapter.
 * - **No reveal, read-back, or "get password" call of any kind.** There is no
 *   shape here through which a stored mailbox password could travel back.
 */

/** One DNS record the mail provider requires, zone-relative. */
export interface MailDnsRecord {
  type: string;
  /** ZONE-RELATIVE (`@`, `_dmarc`, `purelymail1._domainkey`). */
  name: string;
  content: string;
  ttlSeconds: number | null;
  priority: number | null;
  /** What the record is for, for a legible run step. Never persisted. */
  purpose: string;
}

/** The provider's own verdict on a domain's published records. */
export interface MailDnsSummary {
  passesMx: boolean;
  passesSpf: boolean;
  passesDkim: boolean;
  passesDmarc: boolean;
}

/** A registered mail domain, as much of it as this domain needs. */
export interface MailDomainState {
  name: string;
  /**
   * Whether this domain may reset the mail ACCOUNT's password. Loxep never
   * enables it; it is observed so that "it is off" is a fact rather than an
   * assumption.
   */
  allowAccountReset: boolean;
  /** A provider-owned shared domain, which Loxep never manages. */
  isShared: boolean;
  dns: MailDnsSummary;
}

/** An alias or catch-all as the provider expresses it. */
export interface MailRoutingRule {
  id: number;
  domainName: string;
  prefix: boolean;
  /** Local part. */
  matchUser: string;
  targetAddresses: string[];
  catchall: boolean;
}

export interface MailProviderCapabilities {
  provider: string;
  routingRules: boolean;
  catchAll: boolean;
  /** Whether the PROVIDER generates the password (Loxep mints it when false). */
  suppliesMailboxPassword: boolean;
  /** Whether one ownership code proves the account or only one domain. */
  ownershipCodeScope: "account" | "domain";
  maxListedUsers: number;
  requiredRecordCount: number;
}

export interface CreateMailUserInput {
  /** LOCAL PART. */
  userName: string;
  domainName: string;
  /** A minted password. Write-only: it goes in and never comes back out. */
  password: string;
  enablePasswordReset?: boolean;
  enableSearchIndexing?: boolean;
  sendWelcomeEmail?: boolean;
}

export interface CreateMailRoutingRuleInput {
  domainName: string;
  matchUser: string;
  targetAddresses: readonly string[];
  prefix?: boolean;
  catchall?: boolean;
}

/**
 * The minimal contract that makes the mail reconciler provider-agnostic.
 *
 * `findDomainByName` and `listUsers` are the two READ-BACK members, and they
 * exist for the same reason `findZoneByName` does on the DNS port: resolving a
 * `pending` `provider_operations` row by reading the provider is the design's
 * open question 4, and a mailbox create is billable — the one place a blind
 * retry costs money.
 */
export interface MailProviderPort {
  /** The ownership code to publish as a TXT record. */
  getOwnershipCode(): Promise<string>;
  /** Register a domain. FAILS until the ownership TXT resolves publicly. */
  addDomain(domainName: string): Promise<void>;
  /** Read-back: the registered domain, or `null`. */
  findDomainByName(name: string): Promise<MailDomainState | null>;
  /** Ask the provider to re-check the domain's DNS now. */
  recheckDomainDns(domainName: string): Promise<void>;
  /** Create a mailbox. BILLABLE and not idempotent. */
  createUser(input: CreateMailUserInput): Promise<void>;
  /** Delete a mailbox, by FULL address. Destructive: it takes the mail. */
  deleteUser(fullAddress: string): Promise<void>;
  /** Read-back: every address on the account. */
  listUsers(): Promise<string[]>;
  listRoutingRules(): Promise<MailRoutingRule[]>;
  createRoutingRule(input: CreateMailRoutingRuleInput): Promise<void>;
  deleteRoutingRule(routingRuleId: number): Promise<void>;
  /** The provider's required DNS record set for a domain. */
  requiredRecords(input: {
    domainName: string;
    ownershipCode: string | null;
  }): MailDnsRecord[];
  capabilities(): MailProviderCapabilities;
}

/**
 * Mints one mailbox password. Injected rather than implemented here so the
 * composition root owns the entropy source and a test can be deterministic.
 *
 * The default in `mail-sync.ts` uses `node:crypto`. A caller that supplies its
 * own is responsible for the strength of what it returns — this domain never
 * inspects, validates, or logs the value.
 */
export type PasswordMinter = () => string;

/**
 * The write-only half of `@loxep/domain`'s secrets service, re-declared
 * structurally so this package needs neither the keyring nor the full service
 * type to store a minted password.
 *
 * **There is deliberately no read member.** Not "there is one and we do not
 * call it" — the port has no shape through which a stored password could be
 * retrieved, so no future edit to this package can start revealing one without
 * first widening this interface, which is a visible change.
 *
 * ADR-0022 (PROVISIONAL) settles what that means here: *"reveal-once at mint
 * time; write-only forever after"*, where the one-time reveal happens **in the
 * response to the creating action**. This mint has no such response — it
 * happens inside a worker job, minutes or days after the operator asked for the
 * mailbox, with nobody waiting on it. Clause 1 therefore has nothing to fire
 * into and clause 2 applies from birth: no read-back path, and a lost password
 * is a rotation rather than a recovery.
 */
export interface MailboxSecretWriter {
  setSecret(input: {
    secretKey: string;
    purpose: "mailbox_password";
    payload: { password: string };
    actorUserId?: string | null;
  }): Promise<{ id: string }>;
}
