/**
 * Scratch-database lifecycle against the dev database (docker/compose.dev.yml,
 * host port 5433), plus the stub DNS provider every reconcile test drives.
 *
 * Each test file creates its own scratch database so files run in parallel and
 * never depend on leftover state.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import type {
  DnsApplyOperation,
  DnsApplyResult,
  DnsProviderCapabilities,
  DnsProviderPort,
  ObservedDnsRecord,
  ProviderZone,
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
