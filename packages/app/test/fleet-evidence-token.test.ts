import { describe, expect, it } from "vitest";
import {
  ConnectionNotFoundError,
  EVIDENCE_INGEST_CONNECTION_KIND,
  SecretNotFoundError,
} from "@loxep/domain";
import type {
  Connection,
  ConnectionCredentialsService,
  ConnectionsService,
} from "@loxep/domain";
import { verifyFleetIngestToken } from "../src/fleet-evidence.ts";

const VALID_CONNECTION_ID = "10000000-0000-4000-8000-000000000001";

function connection(kind = EVIDENCE_INGEST_CONNECTION_KIND): Connection {
  const now = new Date("2026-08-31T00:00:00.000Z");
  return {
    id: VALID_CONNECTION_ID,
    provider: "generic",
    kind,
    name: "evidence source",
    status: "active",
    economicEntityId: null,
    externalAccountId: null,
    externalAccountName: null,
    config: {},
    createdByUserId: "test-user",
    createdAt: now,
    updatedAt: now,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
  };
}

interface DependencyHarnessOptions {
  connection?: Connection;
  connectionError?: Error;
  storedToken?: string;
  credentialError?: Error;
}

function dependencyHarness(options: DependencyHarnessOptions) {
  const calls: Array<{
    dependency: "connections" | "credentials";
    connectionId: string;
    credentialType?: string;
  }> = [];

  const connections = {
    async getConnection(connectionId: string) {
      calls.push({ dependency: "connections", connectionId });
      if (options.connectionError !== undefined) throw options.connectionError;
      if (options.connection === undefined) {
        throw new Error("test harness needs a connection or connection error");
      }
      return options.connection;
    },
  } as unknown as ConnectionsService;

  const connectionCredentials = {
    async getCredentialPayload(connectionId: string, credentialType: string) {
      calls.push({ dependency: "credentials", connectionId, credentialType });
      if (options.credentialError !== undefined) throw options.credentialError;
      if (options.storedToken === undefined) {
        throw new Error("test harness needs a token or credential error");
      }
      return {
        purpose: "fleet_ingest_token" as const,
        payload: { token: options.storedToken },
      };
    },
  } as unknown as ConnectionCredentialsService;

  return { calls, connections, connectionCredentials };
}

describe("verifyFleetIngestToken dependency work", () => {
  const unauthorizedCases: Array<{
    name: string;
    connectionId: string;
    dependencies: DependencyHarnessOptions;
  }> = [
    {
      name: "malformed connection id",
      connectionId: "not-a-uuid",
      dependencies: {
        connectionError: new ConnectionNotFoundError("not found"),
        credentialError: new SecretNotFoundError("not found"),
      },
    },
    {
      name: "unknown connection",
      connectionId: VALID_CONNECTION_ID,
      dependencies: {
        connectionError: new ConnectionNotFoundError("not found"),
        credentialError: new SecretNotFoundError("not found"),
      },
    },
    {
      name: "connection of the wrong kind",
      connectionId: VALID_CONNECTION_ID,
      dependencies: {
        connection: connection("store"),
        credentialError: new SecretNotFoundError("not found"),
      },
    },
    {
      name: "wrong token",
      connectionId: VALID_CONNECTION_ID,
      dependencies: {
        connection: connection(),
        storedToken: "correct-token-value",
      },
    },
  ];

  for (const testCase of unauthorizedCases) {
    it(`performs normalized dependency work for a ${testCase.name}`, async () => {
      const harness = dependencyHarness(testCase.dependencies);

      const result = await verifyFleetIngestToken({
        connections: harness.connections,
        connectionCredentials: harness.connectionCredentials,
        connectionId: testCase.connectionId,
        presentedToken: "wrong-token-value",
      });

      expect(result).toEqual({ ok: false });
      expect(harness.calls.map(({ dependency }) => dependency)).toEqual([
        "connections",
        "credentials",
      ]);
      expect(harness.calls[1]?.credentialType).toBe("fleet_ingest_token");
      expect(harness.calls[0]?.connectionId).toBe(harness.calls[1]?.connectionId);
      if (testCase.connectionId === "not-a-uuid") {
        expect(harness.calls[0]?.connectionId).not.toBe(testCase.connectionId);
      } else {
        expect(harness.calls[0]?.connectionId).toBe(testCase.connectionId);
      }
    });
  }
});
