/**
 * The DNS provider port: the shapes this domain needs from an adapter,
 * **re-declared structurally rather than imported**.
 *
 * `@loxep/infrastructure` takes NO dependency on
 * `@loxep/integration-cloudflare`, exactly as `@loxep/commerce` takes none on
 * `@loxep/integration-ebay`. The composition root holds both and passes an
 * adapter in. The consequence is the intended one: a second DNS provider needs
 * a new integration package and no change here, and this package's tests run
 * against a stub with no provider code in the graph at all.
 *
 * The duplication is guarded the way every other structural re-declaration in
 * Loxep is — by a compile-time assignability test in the composition root's
 * suite, so a drift between the two shapes fails a test rather than a
 * production sync.
 */

/** One observed DNS record at the provider, in Loxep's vocabulary. */
export interface ObservedDnsRecord {
  externalRecordId: string;
  type: string;
  /** ZONE-RELATIVE (`@`, `*`, `key1._domainkey`), matching `dns_records.name`. */
  name: string;
  content: string;
  /** `null` means "provider default". A provider sentinel never reaches here. */
  ttlSeconds: number | null;
  priority: number | null;
  proxied: boolean;
  /** Whether the provider CAN proxy this record; drives honest degradation. */
  proxiable: boolean;
}

/** The record shape an apply operation carries. */
export interface DnsRecordPayload {
  type: string;
  name: string;
  content: string;
  ttlSeconds: number | null;
  priority: number | null;
  proxied: boolean;
}

export type DnsApplyOperation =
  | { kind: "create"; record: DnsRecordPayload }
  | { kind: "update"; externalRecordId: string; record: DnsRecordPayload }
  | {
      kind: "delete";
      externalRecordId: string;
      record: Pick<DnsRecordPayload, "type" | "name" | "content">;
    };

export interface DnsApplyResult {
  kind: DnsApplyOperation["kind"];
  type: string;
  name: string;
  status: "applied" | "already_present" | "already_absent";
  externalRecordId: string | null;
}

export interface DnsProviderCapabilities {
  provider: string;
  proxying: boolean;
  proxiableTypes: readonly string[];
  proxiedWildcards: boolean;
  wildcardRecords: boolean;
  automaticTtl: boolean;
  minTtlSeconds: number;
  maxTtlSeconds: number;
  automaticCertificateLabelDepth: number;
}

/** A provider zone, as much of it as this domain needs. */
export interface ProviderZone {
  externalZoneId: string;
  name: string;
  /** The provider's own string, verbatim. Only `active` is branched on. */
  status: string;
  nameservers: string[];
}

/**
 * The minimal contract that makes the reconciler provider-agnostic — the
 * design's `read` / `apply` / `capabilities` triple.
 *
 * `findZoneByName` is the fourth member and exists for one reason: resolving a
 * domain to its zone is how `provider_operations` reconciles a `pending`
 * zone-create by READING the provider back (open question 4's resolution)
 * rather than blindly retrying a non-idempotent call.
 */
export interface DnsProviderPort {
  findZoneByName(name: string): Promise<ProviderZone | null>;
  read(subject: {
    externalZoneId: string;
    zoneName: string;
  }): Promise<ObservedDnsRecord[]>;
  apply(input: {
    externalZoneId: string;
    zoneName: string;
    operations: readonly DnsApplyOperation[];
  }): Promise<DnsApplyResult[]>;
  capabilities(): DnsProviderCapabilities;
}

/**
 * A redactor for a provider response, injected by the composition root so a
 * `reconcile_run_steps` summary can never receive an unredacted payload. The
 * adapter owns the implementation because the adapter owns the knowledge of
 * which fields are sensitive.
 */
export type ResponseRedactor = (value: unknown) => Record<string, unknown>;
