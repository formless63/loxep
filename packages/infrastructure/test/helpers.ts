/**
 * Scratch-database lifecycle against the dev database (docker/compose.dev.yml,
 * host port 5433), plus the stub DNS provider every reconcile test drives.
 *
 * Each test file creates its own scratch database so files run in parallel and
 * never depend on leftover state.
 */
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import pg from "pg";
import type {
  DnsApplyOperation,
  DnsApplyResult,
  DnsProviderCapabilities,
  DnsProviderPort,
  DnsTokenMintResult,
  DnsTokenProviderPort,
  DnsTokenRollResult,
  MailDnsRecord,
  MailDnsSummary,
  MailDomainState,
  MailProviderCapabilities,
  MailProviderPort,
  MailRoutingRule,
  MailboxSecretWriter,
  ObservedDnsRecord,
  ProviderZone,
  TransactionalDnsTokenSecretWriter,
} from "../src/index.ts";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export const baseDatabaseUrl =
  process.env["LOXEP_TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;

function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function scratchDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export async function createScratchDb(databaseName: string): Promise<string> {
  const client = new pg.Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    await client.query(`create database "${databaseName}"`);
  } finally {
    await client.end();
  }
  return databaseUrlFor(databaseName);
}

export async function dropScratchDb(databaseName: string): Promise<void> {
  const client = new pg.Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    await client.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await client.end();
  }
}

export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/* --------------------------------------------------------- stub provider */

export interface StubProviderOptions {
  zoneName: string;
  externalZoneId: string;
  records?: ObservedDnsRecord[];
  /**
   * Throw on the Nth apply operation (0-based), simulating a crash mid-apply.
   * Operations before it are still committed at the "provider", which is what
   * makes the at-least-once rerun test real rather than decorative.
   */
  failApplyAtIndex?: number;
  failRead?: { kind: string; message: string };
}

export interface StubProvider extends DnsProviderPort {
  /** The provider's current state, readable by assertions. */
  state(): ObservedDnsRecord[];
  readonly applyCalls: DnsApplyOperation[][];
  readonly readCalls: number;
  setFailApplyAtIndex(index: number | undefined): void;
}

let stubRecordSeq = 0;

export function createStubProvider(
  options: StubProviderOptions,
): StubProvider {
  const records = new Map<string, ObservedDnsRecord>(
    (options.records ?? []).map((record) => [record.externalRecordId, record]),
  );
  const applyCalls: DnsApplyOperation[][] = [];
  let readCalls = 0;
  let failApplyAtIndex = options.failApplyAtIndex;

  const key = (record: { type: string; name: string; content: string }) =>
    `${record.type} ${record.name} ${record.content}`;

  const provider: StubProvider = {
    async findZoneByName(name): Promise<ProviderZone | null> {
      if (name !== options.zoneName) return null;
      return {
        externalZoneId: options.externalZoneId,
        name: options.zoneName,
        status: "active",
        nameservers: ["ns1.stub.test", "ns2.stub.test"],
      };
    },

    async read() {
      readCalls += 1;
      if (options.failRead !== undefined) {
        const error = new Error(options.failRead.message) as Error & {
          kind: string;
        };
        error.kind = options.failRead.kind;
        throw error;
      }
      return [...records.values()];
    },

    async apply({ operations }) {
      applyCalls.push([...operations]);
      const results: DnsApplyResult[] = [];
      for (let i = 0; i < operations.length; i += 1) {
        if (failApplyAtIndex !== undefined && i === failApplyAtIndex) {
          const error = new Error("stub provider crashed mid-apply") as Error & {
            kind: string;
          };
          error.kind = "provider_unavailable";
          throw error;
        }
        const operation = operations[i] as DnsApplyOperation;
        if (operation.kind === "create") {
          const existing = [...records.values()].find(
            (record) => key(record) === key(operation.record),
          );
          if (existing !== undefined) {
            results.push({
              kind: "create",
              type: operation.record.type,
              name: operation.record.name,
              status: "already_present",
              externalRecordId: existing.externalRecordId,
            });
            continue;
          }
          stubRecordSeq += 1;
          const id = `stub-rec-${stubRecordSeq}`;
          records.set(id, {
            externalRecordId: id,
            type: operation.record.type,
            name: operation.record.name,
            content: operation.record.content,
            ttlSeconds: operation.record.ttlSeconds,
            priority: operation.record.priority,
            proxied: operation.record.proxied,
            proxiable: ["A", "AAAA", "CNAME"].includes(operation.record.type),
          });
          results.push({
            kind: "create",
            type: operation.record.type,
            name: operation.record.name,
            status: "applied",
            externalRecordId: id,
          });
          continue;
        }
        if (operation.kind === "update") {
          const existing = records.get(operation.externalRecordId);
          if (existing === undefined) {
            const error = new Error("no such record") as Error & { kind: string };
            error.kind = "not_found";
            throw error;
          }
          records.set(operation.externalRecordId, {
            ...existing,
            content: operation.record.content,
            ttlSeconds: operation.record.ttlSeconds,
            priority: operation.record.priority,
            proxied: operation.record.proxied,
          });
          results.push({
            kind: "update",
            type: operation.record.type,
            name: operation.record.name,
            status: "applied",
            externalRecordId: operation.externalRecordId,
          });
          continue;
        }
        const present = records.delete(operation.externalRecordId);
        results.push({
          kind: "delete",
          type: operation.record.type,
          name: operation.record.name,
          status: present ? "applied" : "already_absent",
          externalRecordId: operation.externalRecordId,
        });
      }
      return results;
    },

    capabilities(): DnsProviderCapabilities {
      return {
        provider: "stub",
        proxying: true,
        proxiableTypes: ["A", "AAAA", "CNAME"],
        proxiedWildcards: true,
        wildcardRecords: true,
        automaticTtl: true,
        minTtlSeconds: 60,
        maxTtlSeconds: 86_400,
        automaticCertificateLabelDepth: 1,
      };
    },

    state() {
      return [...records.values()];
    },

    get applyCalls() {
      return applyCalls;
    },

    get readCalls() {
      return readCalls;
    },

    setFailApplyAtIndex(index) {
      failApplyAtIndex = index;
    },
  };

  return provider;
}

/* ---------------------------------------------------- stub MAIL provider */

/**
 * The mail half of the stubs (milestone 2).
 *
 * Same discipline as the DNS stub above and for the same reason: this package
 * takes no dependency on a mail integration package, so its tests must be able
 * to drive `MailProviderPort` with no provider code in the graph at all. The
 * stub is structural — it never imports `@loxep/integration-purelymail`.
 *
 * Two things it deliberately makes easy, because the reconciler's whole design
 * turns on them:
 *
 * 1. **Counting provider calls.** The delegation gate's claim is that a gated
 *    run makes ZERO provider calls, which can only be asserted against a
 *    counter. {@link StubMailProvider.calls} is that counter.
 * 2. **Injecting a classified failure.** `addDomain` rejecting with
 *    `invalid_request` (the ownership TXT is not resolvable yet) and rejecting
 *    with `auth` (a real fault) must produce completely different behavior, so
 *    the failure carries a `kind` property on the thrown `Error` exactly as the
 *    DNS stub's does — that string is the only thing that crosses the adapter
 *    boundary (ADR-0009).
 */
export interface StubMailFailure {
  kind: string;
  message: string;
}

export interface StubMailDomainSeed {
  name: string;
  dns?: Partial<MailDnsSummary>;
  allowAccountReset?: boolean;
  isShared?: boolean;
}

export interface StubMailProviderOptions {
  /** The account-level ownership code. PUBLIC by construction. */
  ownershipCode?: string;
  /** Domains the provider already knows about before the run. */
  domains?: StubMailDomainSeed[];
  /** Full addresses (`local@domain`) already on the account. */
  users?: string[];
  routingRules?: MailRoutingRule[];
  /**
   * The DNS verdict a domain registered by `addDomain` starts with. Defaults
   * to all four checks passing, so the happy path is the terse one.
   */
  dnsOnRegister?: Partial<MailDnsSummary>;
  failAddDomainWith?: StubMailFailure;
  failOwnershipCodeWith?: StubMailFailure;
  failCreateUserWith?: StubMailFailure;
}

/** One counter per port member — the delegation gate's assertion surface. */
export interface StubMailProviderCalls {
  getOwnershipCode: number;
  addDomain: number;
  findDomainByName: number;
  recheckDomainDns: number;
  createUser: number;
  deleteUser: number;
  listUsers: number;
  listRoutingRules: number;
  createRoutingRule: number;
  deleteRoutingRule: number;
}

export interface StubMailProvider extends MailProviderPort {
  readonly calls: StubMailProviderCalls;
  /** Every provider call made, in order, for a legible failure message. */
  readonly callLog: string[];
  /** The provider's current address list, readable by assertions. */
  userAddresses(): string[];
  rules(): MailRoutingRule[];
  hasDomain(name: string): boolean;
  registerDomain(name: string, dns?: Partial<MailDnsSummary>): void;
  setDomainDns(name: string, dns: Partial<MailDnsSummary>): void;
  setFailAddDomainWith(failure: StubMailFailure | undefined): void;
  setFailCreateUserWith(failure: StubMailFailure | undefined): void;
  /**
   * The password the provider was handed for one address. The provider is the
   * one party that legitimately receives it, so this exists ONLY to prove
   * containment — that the marker a boundary test looks for really did travel,
   * which is what makes its absence everywhere else meaningful.
   */
  passwordFor(fullAddress: string): string | undefined;
}

const ALL_PASS: MailDnsSummary = {
  passesMx: true,
  passesSpf: true,
  passesDkim: true,
  passesDmarc: true,
};

function summary(overrides: Partial<MailDnsSummary> | undefined): MailDnsSummary {
  return { ...ALL_PASS, ...(overrides ?? {}) };
}

function kindedError(failure: StubMailFailure): Error & { kind: string } {
  const error = new Error(failure.message) as Error & { kind: string };
  error.kind = failure.kind;
  return error;
}

let stubRuleSeq = 0;

export function createStubMailProvider(
  options: StubMailProviderOptions = {},
): StubMailProvider {
  const domains = new Map<string, MailDomainState>(
    (options.domains ?? []).map((seed) => [
      seed.name,
      {
        name: seed.name,
        allowAccountReset: seed.allowAccountReset ?? false,
        isShared: seed.isShared ?? false,
        dns: summary(seed.dns),
      },
    ]),
  );
  const users = new Set<string>(options.users ?? []);
  const rules: MailRoutingRule[] = [...(options.routingRules ?? [])];
  const passwords = new Map<string, string>();
  const callLog: string[] = [];
  const calls: StubMailProviderCalls = {
    getOwnershipCode: 0,
    addDomain: 0,
    findDomainByName: 0,
    recheckDomainDns: 0,
    createUser: 0,
    deleteUser: 0,
    listUsers: 0,
    listRoutingRules: 0,
    createRoutingRule: 0,
    deleteRoutingRule: 0,
  };
  let failAddDomainWith = options.failAddDomainWith;
  let failCreateUserWith = options.failCreateUserWith;

  const record = (member: keyof StubMailProviderCalls): void => {
    calls[member] += 1;
    callLog.push(member);
  };

  return {
    async getOwnershipCode() {
      record("getOwnershipCode");
      if (options.failOwnershipCodeWith !== undefined) {
        throw kindedError(options.failOwnershipCodeWith);
      }
      return options.ownershipCode ?? "stub-ownership-code";
    },

    async addDomain(domainName) {
      record("addDomain");
      if (failAddDomainWith !== undefined) throw kindedError(failAddDomainWith);
      domains.set(domainName, {
        name: domainName,
        allowAccountReset: false,
        isShared: false,
        dns: summary(options.dnsOnRegister),
      });
    },

    async findDomainByName(name) {
      record("findDomainByName");
      return domains.get(name) ?? null;
    },

    async recheckDomainDns(domainName) {
      record("recheckDomainDns");
      void domainName;
    },

    async createUser(input) {
      record("createUser");
      if (failCreateUserWith !== undefined) {
        throw kindedError(failCreateUserWith);
      }
      const address = `${input.userName}@${input.domainName}`;
      users.add(address);
      passwords.set(address, input.password);
    },

    async deleteUser(fullAddress) {
      record("deleteUser");
      users.delete(fullAddress);
    },

    async listUsers() {
      record("listUsers");
      return [...users];
    },

    async listRoutingRules() {
      record("listRoutingRules");
      return rules.map((rule) => ({ ...rule }));
    },

    async createRoutingRule(input) {
      record("createRoutingRule");
      stubRuleSeq += 1;
      rules.push({
        id: stubRuleSeq,
        domainName: input.domainName,
        prefix: input.prefix ?? false,
        matchUser: input.matchUser,
        targetAddresses: [...input.targetAddresses],
        catchall: input.catchall ?? false,
      });
    },

    async deleteRoutingRule(routingRuleId) {
      record("deleteRoutingRule");
      const index = rules.findIndex((rule) => rule.id === routingRuleId);
      if (index >= 0) rules.splice(index, 1);
    },

    requiredRecords({ domainName, ownershipCode }): MailDnsRecord[] {
      const records: MailDnsRecord[] = [
        {
          type: "MX",
          name: "@",
          content: `mail.${domainName}`,
          ttlSeconds: null,
          priority: 10,
          purpose: "inbound mail",
        },
        {
          type: "TXT",
          name: "@",
          content: "v=spf1 include:stub.test ~all",
          ttlSeconds: null,
          priority: null,
          purpose: "spf",
        },
        {
          type: "CNAME",
          name: "stub1._domainkey",
          content: "stub1.dkim.stub.test",
          ttlSeconds: null,
          priority: null,
          purpose: "dkim",
        },
        {
          type: "TXT",
          name: "_dmarc",
          content: "v=DMARC1; p=none",
          ttlSeconds: null,
          priority: null,
          purpose: "dmarc",
        },
      ];
      if (ownershipCode !== null) {
        records.push({
          type: "TXT",
          name: "@",
          content: `stub-verification=${ownershipCode}`,
          ttlSeconds: null,
          priority: null,
          purpose: "ownership proof",
        });
      }
      return records;
    },

    capabilities(): MailProviderCapabilities {
      return {
        provider: "stub-mail",
        routingRules: true,
        catchAll: true,
        suppliesMailboxPassword: false,
        ownershipCodeScope: "account",
        maxListedUsers: 1_000,
        requiredRecordCount: 4,
      };
    },

    get calls() {
      return calls;
    },

    get callLog() {
      return callLog;
    },

    userAddresses() {
      return [...users];
    },

    rules() {
      return rules.map((rule) => ({ ...rule }));
    },

    hasDomain(name) {
      return domains.has(name);
    },

    registerDomain(name, dns) {
      domains.set(name, {
        name,
        allowAccountReset: false,
        isShared: false,
        dns: summary(dns),
      });
    },

    setDomainDns(name, dns) {
      const existing = domains.get(name);
      if (existing === undefined) return;
      domains.set(name, { ...existing, dns: { ...existing.dns, ...dns } });
    },

    setFailAddDomainWith(failure) {
      failAddDomainWith = failure;
    },

    setFailCreateUserWith(failure) {
      failCreateUserWith = failure;
    },

    passwordFor(fullAddress) {
      return passwords.get(fullAddress);
    },
  };
}

/* -------------------------------------------- stub DNS token provider --- */

export interface StubTokenProviderOptions {
  /** Fails the NEXT mint call. Cleared after it fires once. */
  failMintOnce?: { kind: string; message: string };
  /** Fails the NEXT roll call. Cleared after it fires once. */
  failRollOnce?: { kind: string; message: string };
  /** Fails EVERY updatePolicy call, for testing the failure path repeatedly. */
  failUpdatePolicy?: { kind: string; message: string };
}

export interface StubTokenProvider extends DnsTokenProviderPort {
  readonly mintCalls: ReadonlyArray<{
    name: string;
    permissionScope: string;
    zoneExternalIds: readonly string[];
  }>;
  readonly rollCalls: readonly string[];
  readonly updatePolicyCalls: ReadonlyArray<{
    externalTokenId: string;
    zoneExternalIds: readonly string[];
  }>;
}

class StubProviderCallError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

let stubTokenSeq = 0;

export function createStubTokenProvider(
  options: StubTokenProviderOptions = {},
): StubTokenProvider {
  const mintCalls: Array<{
    name: string;
    permissionScope: string;
    zoneExternalIds: readonly string[];
  }> = [];
  const rollCalls: string[] = [];
  const updatePolicyCalls: Array<{
    externalTokenId: string;
    zoneExternalIds: readonly string[];
  }> = [];
  const created = new Set<string>();
  let failMintOnce = options.failMintOnce;
  let failRollOnce = options.failRollOnce;

  return {
    async mintToken(input): Promise<DnsTokenMintResult> {
      mintCalls.push({ ...input });
      if (failMintOnce !== undefined) {
        const failure = failMintOnce;
        failMintOnce = undefined;
        throw new StubProviderCallError(failure.kind, failure.message);
      }
      stubTokenSeq += 1;
      const externalTokenId = `stub-token-${stubTokenSeq}`;
      created.add(externalTokenId);
      return { externalTokenId, value: `stub-value-${stubTokenSeq}` };
    },

    async rollToken(externalTokenId): Promise<DnsTokenRollResult> {
      rollCalls.push(externalTokenId);
      if (failRollOnce !== undefined) {
        const failure = failRollOnce;
        failRollOnce = undefined;
        throw new StubProviderCallError(failure.kind, failure.message);
      }
      stubTokenSeq += 1;
      return { value: `stub-rolled-value-${stubTokenSeq}` };
    },

    async updatePolicy(externalTokenId, zoneExternalIds): Promise<void> {
      updatePolicyCalls.push({ externalTokenId, zoneExternalIds });
      if (options.failUpdatePolicy !== undefined) {
        throw new StubProviderCallError(
          options.failUpdatePolicy.kind,
          options.failUpdatePolicy.message,
        );
      }
    },

    async findTokenById(externalTokenId): Promise<{ exists: boolean }> {
      return { exists: created.has(externalTokenId) };
    },

    get mintCalls() {
      return mintCalls;
    },
    get rollCalls() {
      return rollCalls;
    },
    get updatePolicyCalls() {
      return updatePolicyCalls;
    },
  };
}

/**
 * A {@link TransactionalDnsTokenSecretWriter} that writes through WHATEVER
 * transaction handle it is given — the property the atomicity tests exist to
 * exercise — and records what was stored, never a value in an assertion
 * message.
 *
 * Raw SQL against `application_secrets` rather than the real
 * `@loxep/domain` secrets service, for the same reason `helpers.ts` already
 * makes that choice for mailbox passwords: this suite is testing `tokens.ts`'s
 * transaction shape, not `@loxep/domain`'s encryption, and a real service
 * would need a keyring this package deliberately has no dependency on.
 */
export function createRecordingDnsTokenSecretWriter(): TransactionalDnsTokenSecretWriter & {
  readonly writes: ReadonlyArray<{ secretKey: string; purpose: "dns_edit_token" }>;
  writeCountFor(secretKey: string): number;
  storedValueContains(marker: string): boolean;
} {
  const writes: Array<{ secretKey: string; purpose: "dns_edit_token" }> = [];
  const stored: string[] = [];

  const writer = (async (tx, input) => {
    writes.push({ secretKey: input.secretKey, purpose: input.purpose });
    stored.push(input.payload.token);
    const result = await tx.execute<{ id: string }>(sql`
      insert into application_secrets (secret_key, purpose, current_version)
      values (${input.secretKey}, ${input.purpose}, 1)
      on conflict (secret_key)
        do update set current_version = application_secrets.current_version + 1,
                      updated_at = now()
      returning id
    `);
    const rows = (result as unknown as { rows?: Array<{ id: string }> }).rows;
    const id = rows?.[0]?.id;
    if (id === undefined) throw new Error("secret upsert returned no row");
    return { id };
  }) as TransactionalDnsTokenSecretWriter & {
    writes: typeof writes;
    writeCountFor(secretKey: string): number;
    storedValueContains(marker: string): boolean;
  };

  Object.defineProperty(writer, "writes", { value: writes, enumerable: true });
  writer.writeCountFor = (secretKey) =>
    writes.filter((entry) => entry.secretKey === secretKey).length;
  writer.storedValueContains = (marker) =>
    stored.some((value) => value.includes(marker));

  return writer;
}

/* ------------------------------------------------ recording secret writer */

/**
 * A {@link MailboxSecretWriter} that records WHAT was stored and WHERE, and
 * nothing else.
 *
 * The port has no read member on purpose (`mail-port.ts`: "no future edit to
 * this package can start revealing one without first widening this interface"),
 * so this stub keeps the same shape: `writes` carries the secret key and the
 * purpose, never the value. The single accessor that touches the value is
 * {@link RecordingSecretWriter.storedValueContains}, a boolean containment
 * probe — enough to prove a marker really was stored, not enough to hand a
 * password to an assertion message.
 *
 * It inserts a REAL `application_secrets` row rather than inventing a uuid,
 * because `mailboxes.secret_id` is a foreign key: a fake id would make the
 * "the reconciler sets `secret_id`" assertion pass against a database that
 * would have rejected it in production.
 */
export interface RecordingSecretWriter extends MailboxSecretWriter {
  readonly writes: ReadonlyArray<{
    secretKey: string;
    purpose: "mailbox_password";
  }>;
  /** How many times one key was written — i.e. "was it rotated?". */
  writeCountFor(secretKey: string): number;
  /** The only value read-back this suite permits itself, to prove containment. */
  storedValueContains(marker: string): boolean;
}

export function createRecordingSecretWriter(options: {
  pool: pg.Pool;
}): RecordingSecretWriter {
  const writes: Array<{ secretKey: string; purpose: "mailbox_password" }> = [];
  const stored: string[] = [];

  return {
    async setSecret(input) {
      writes.push({ secretKey: input.secretKey, purpose: input.purpose });
      stored.push(input.payload.password);
      const result = await options.pool.query<{ id: string }>(
        `insert into application_secrets (secret_key, purpose, current_version)
         values ($1, $2, 1)
         on conflict (secret_key)
           do update set current_version = application_secrets.current_version + 1,
                         updated_at = now()
         returning id`,
        [input.secretKey, input.purpose],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error("secret upsert returned no row");
      return { id };
    },

    get writes() {
      return writes;
    },

    writeCountFor(secretKey) {
      return writes.filter((entry) => entry.secretKey === secretKey).length;
    },

    storedValueContains(marker) {
      return stored.some((value) => value.includes(marker));
    },
  };
}

/** An observed record with sensible defaults, for terse test setup. */
export function observed(
  overrides: Partial<ObservedDnsRecord> & { externalRecordId: string },
): ObservedDnsRecord {
  return {
    type: "A",
    name: "@",
    content: "203.0.113.10",
    ttlSeconds: null,
    priority: null,
    proxied: false,
    proxiable: true,
    ...overrides,
  };
}
