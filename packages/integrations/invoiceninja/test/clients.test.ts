import { describe, expect, it } from "vitest";
import {
  InvoiceNinjaAdapterError,
  buildInvoiceNinjaClientPayload,
  createClient,
  createInvoiceNinjaAdapter,
  fetchClient,
  fetchClientsPage,
  isoFromInvoiceNinjaTimestamp,
  mapInvoiceNinjaClient,
  redactInvoiceNinjaClientFact,
  updateClient,
} from "../src/index.ts";
import { TEST_BASE_URL, TEST_TOKEN, createFetchStub } from "./http.ts";
import { clientFixture, newClientFixture, ninjaItemEnvelope, ninjaListEnvelope } from "./fixtures.ts";

function makeAdapter(stub: ReturnType<typeof createFetchStub>) {
  return createInvoiceNinjaAdapter({
    baseUrl: TEST_BASE_URL,
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
  });
}

describe("isoFromInvoiceNinjaTimestamp", () => {
  it("converts a Unix-SECONDS epoch to an ISO instant", () => {
    expect(isoFromInvoiceNinjaTimestamp(1786598400)).toBe("2026-08-13T05:20:00.000Z");
  });

  it("maps 0/absent/non-numeric to null rather than the Unix epoch", () => {
    expect(isoFromInvoiceNinjaTimestamp(0)).toBeNull();
    expect(isoFromInvoiceNinjaTimestamp(undefined)).toBeNull();
    expect(isoFromInvoiceNinjaTimestamp("not a number")).toBeNull();
    expect(isoFromInvoiceNinjaTimestamp(-5)).toBeNull();
  });
});

describe("mapInvoiceNinjaClient", () => {
  it("maps every field from ClientTransformer's verified shape", () => {
    const fact = mapInvoiceNinjaClient(clientFixture());
    expect(fact.externalClientId).toBe("FIXTURECLIENT01");
    expect(fact.name).toBe("Fixture Roofing Co");
    expect(fact.displayName).toBe("Fixture Roofing Co");
    expect(fact.balance).toBe("0");
    expect(fact.paidToDate).toBe("1250.5");
    expect(fact.isDeleted).toBe(false);
    expect(fact.updatedAt).toBe("2026-08-13T05:20:00.000Z");
    expect(fact.contacts).toHaveLength(1);
    expect(fact.contacts[0]).toEqual({
      externalContactId: "FIXTURECONTACT01",
      firstName: "Jamie",
      lastName: "Fixture",
      email: "jamie@fixture.invalid",
      isPrimary: true,
    });
  });

  it("maps '' fields (number, id_number, vat_number) to null, not empty string", () => {
    const fact = mapInvoiceNinjaClient(clientFixture({ number: "", id_number: "", vat_number: "" }));
    expect(fact.number).toBeNull();
    expect(fact.idNumber).toBeNull();
    expect(fact.vatNumber).toBeNull();
  });

  it("throws provider_unavailable when the payload has no id", () => {
    const { id: _id, ...withoutId } = clientFixture();
    expect(() => mapInvoiceNinjaClient(withoutId)).toThrowError(
      InvoiceNinjaAdapterError,
    );
  });

  it("handles a newly created client with no contacts", () => {
    const fact = mapInvoiceNinjaClient(newClientFixture());
    expect(fact.contacts).toEqual([]);
    expect(fact.balance).toBe("0");
  });
});

describe("redactInvoiceNinjaClientFact", () => {
  it("drops raw and contacts, keeping a count instead", () => {
    const fact = mapInvoiceNinjaClient(clientFixture());
    const redacted = redactInvoiceNinjaClientFact(fact);
    expect(redacted.raw).toBe("[redacted]");
    expect(redacted.contactCount).toBe(1);
    expect((redacted as Record<string, unknown>)["contacts"]).toBeUndefined();
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("jamie@fixture.invalid");
  });
});

describe("buildInvoiceNinjaClientPayload", () => {
  it("sends only name when idNumber is omitted", () => {
    expect(buildInvoiceNinjaClientPayload({ name: "Fixture Co" })).toEqual({
      name: "Fixture Co",
    });
  });

  it("includes id_number when provided", () => {
    expect(
      buildInvoiceNinjaClientPayload({ name: "Fixture Co", idNumber: "TAX-1" }),
    ).toEqual({ name: "Fixture Co", id_number: "TAX-1" });
  });
});

describe("fetchClientsPage / fetchClient / createClient / updateClient", () => {
  it("fetchClientsPage maps every item and surfaces pagination", async () => {
    const stub = createFetchStub([
      {
        body: ninjaListEnvelope([clientFixture(), newClientFixture()], {
          total: 2,
          currentPage: 1,
          totalPages: 1,
        }),
      },
    ]);
    const result = await fetchClientsPage(makeAdapter(stub));
    expect(result.clients).toHaveLength(2);
    expect(result.page.total).toBe(2);
    expect(result.page.hasNextPage).toBe(false);
  });

  it("fetchClient GETs /clients/<id> and maps the single item", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(clientFixture()) }]);
    const fact = await fetchClient(makeAdapter(stub), "FIXTURECLIENT01");
    expect(fact.externalClientId).toBe("FIXTURECLIENT01");
    expect(stub.pathOf(0)).toBe("/api/v1/clients/FIXTURECLIENT01");
  });

  it("createClient POSTs the built payload and maps the response", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(newClientFixture()) }]);
    const adapter = makeAdapter(stub);
    const fact = await createClient(adapter, { name: "Fixture New Co" });
    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.calls[0]?.body).toEqual({ name: "Fixture New Co" });
    expect(fact.externalClientId).toBe("FIXTURECLIENT02");
  });

  it("updateClient PUTs to /clients/<id>", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(clientFixture({ name: "Renamed" })) }]);
    const adapter = makeAdapter(stub);
    const fact = await updateClient(adapter, "FIXTURECLIENT01", { name: "Renamed" });
    expect(stub.pathOf(0)).toBe("/api/v1/clients/FIXTURECLIENT01");
    expect(stub.calls[0]?.method).toBe("PUT");
    expect(fact.name).toBe("Renamed");
  });
});
