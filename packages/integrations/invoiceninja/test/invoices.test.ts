import { describe, expect, it } from "vitest";
import {
  INVOICENINJA_INVOICE_STATUS_MAP,
  InvoiceNinjaAdapterError,
  buildInvoiceNinjaInvoicePayload,
  createInvoice,
  createInvoiceNinjaAdapter,
  fetchInvoice,
  fetchInvoicesPage,
  mapInvoiceNinjaInvoice,
  markInvoiceSent,
  redactInvoiceNinjaInvoiceFact,
  updateInvoice,
} from "../src/index.ts";
import { TEST_BASE_URL, TEST_TOKEN, createFetchStub } from "./http.ts";
import {
  draftInvoiceFixture,
  ninjaItemEnvelope,
  ninjaListEnvelope,
  paidInvoiceFixture,
  sentInvoiceFixture,
} from "./fixtures.ts";

function makeAdapter(stub: ReturnType<typeof createFetchStub>) {
  return createInvoiceNinjaAdapter({
    baseUrl: TEST_BASE_URL,
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
  });
}

describe("mapInvoiceNinjaInvoice", () => {
  it("maps a draft invoice — no number yet, empty portalUrl", () => {
    const fact = mapInvoiceNinjaInvoice(draftInvoiceFixture());
    expect(fact.externalInvoiceId).toBe("FIXTUREINVOICE01");
    expect(fact.externalClientId).toBe("FIXTURECLIENT01");
    expect(fact.number).toBeNull();
    expect(fact.status).toBe("draft");
    expect(fact.statusIdRaw).toBe("1");
    expect(fact.statusRecognized).toBe(true);
    expect(fact.amount).toBe("500");
    expect(fact.balance).toBe("500");
    expect(fact.issueOn).toBe("2026-08-13");
    expect(fact.dueOn).toBe("2026-09-12");
    expect(fact.poNumber).toBe("PROJ-FIXTURE-01");
    expect(fact.portalUrl).toBeNull();
    expect(fact.lineItems).toHaveLength(1);
    expect(fact.lineItems[0]).toEqual({
      quantity: "10",
      cost: "50",
      productKey: null,
      notes: "Consulting — March, 10 hours",
      taxName1: null,
      taxRate1: "0",
    });
  });

  it("maps a sent invoice — number assigned, portalUrl populated", () => {
    const fact = mapInvoiceNinjaInvoice(sentInvoiceFixture());
    expect(fact.status).toBe("sent");
    expect(fact.statusIdRaw).toBe("2");
    expect(fact.number).toBe("INV-0001");
    expect(fact.portalUrl).toBe(
      "https://billing.example.invalid/client/fixtureinvitationkey02/invoice",
    );
  });

  it("maps a paid invoice — balance zero, paidToDate equals amount", () => {
    const fact = mapInvoiceNinjaInvoice(paidInvoiceFixture());
    expect(fact.status).toBe("paid");
    expect(fact.statusIdRaw).toBe("4");
    expect(fact.balance).toBe("0");
    expect(fact.paidToDate).toBe("500");
  });

  it("every mapped status_id round-trips through the status map", () => {
    for (const [raw, status] of Object.entries(INVOICENINJA_INVOICE_STATUS_MAP)) {
      const fact = mapInvoiceNinjaInvoice(draftInvoiceFixture({ status_id: raw }));
      expect(fact.status).toBe(status);
      expect(fact.statusRecognized).toBe(true);
    }
  });

  it("falls back to draft/unrecognized for an unknown status_id, without throwing", () => {
    const fact = mapInvoiceNinjaInvoice(draftInvoiceFixture({ status_id: "99" }));
    expect(fact.status).toBe("draft");
    expect(fact.statusRecognized).toBe(false);
    expect(fact.statusIdRaw).toBe("99");
  });

  it("throws provider_unavailable when the payload has no id", () => {
    const { id: _id, ...withoutId } = draftInvoiceFixture();
    expect(() => mapInvoiceNinjaInvoice(withoutId)).toThrowError(
      InvoiceNinjaAdapterError,
    );
  });

  it("returns null portalUrl when there are no invitations at all", () => {
    const fact = mapInvoiceNinjaInvoice(draftInvoiceFixture({ invitations: [] }));
    expect(fact.portalUrl).toBeNull();
  });
});

describe("redactInvoiceNinjaInvoiceFact", () => {
  it("drops raw, keeping every other field", () => {
    const fact = mapInvoiceNinjaInvoice(draftInvoiceFixture());
    const redacted = redactInvoiceNinjaInvoiceFact(fact);
    expect(redacted.raw).toBe("[redacted]");
    expect(redacted.externalInvoiceId).toBe("FIXTUREINVOICE01");
  });
});

describe("buildInvoiceNinjaInvoicePayload", () => {
  it("never includes a 'number' field — Invoice Ninja assigns it (numbering_source='external')", () => {
    const payload = buildInvoiceNinjaInvoicePayload({
      externalClientId: "FIXTURECLIENT01",
      lineItems: [{ quantity: "10", cost: "50" }],
    });
    expect(payload).not.toHaveProperty("number");
    expect(payload["client_id"]).toBe("FIXTURECLIENT01");
  });

  it("converts decimal-string line items to JSON numbers", () => {
    const payload = buildInvoiceNinjaInvoicePayload({
      externalClientId: "FIXTURECLIENT01",
      lineItems: [
        {
          quantity: "10",
          cost: "50.5",
          notes: "Consulting",
          productKey: "CONSULT",
          taxName1: "Sales Tax",
          taxRate1: "8.25",
        },
      ],
    });
    expect(payload["line_items"]).toEqual([
      {
        quantity: 10,
        cost: 50.5,
        notes: "Consulting",
        product_key: "CONSULT",
        tax_name1: "Sales Tax",
        tax_rate1: 8.25,
      },
    ]);
  });

  it("includes date/due_date/po_number only when provided", () => {
    const payload = buildInvoiceNinjaInvoicePayload({
      externalClientId: "FIXTURECLIENT01",
      issueOn: "2026-08-13",
      dueOn: "2026-09-12",
      poNumber: "PROJ-1",
      lineItems: [],
    });
    expect(payload["date"]).toBe("2026-08-13");
    expect(payload["due_date"]).toBe("2026-09-12");
    expect(payload["po_number"]).toBe("PROJ-1");
  });

  it("throws on a malformed decimal in a line item rather than sending NaN", () => {
    expect(() =>
      buildInvoiceNinjaInvoicePayload({
        externalClientId: "FIXTURECLIENT01",
        lineItems: [{ quantity: "not a number", cost: "50" }],
      }),
    ).toThrow(RangeError);
  });
});

describe("fetchInvoicesPage / fetchInvoice / createInvoice / updateInvoice / markInvoiceSent", () => {
  it("fetchInvoicesPage maps every item and surfaces pagination", async () => {
    const stub = createFetchStub([
      {
        body: ninjaListEnvelope([draftInvoiceFixture(), sentInvoiceFixture()], {
          total: 2,
          currentPage: 1,
          totalPages: 1,
        }),
      },
    ]);
    const result = await fetchInvoicesPage(makeAdapter(stub));
    expect(result.invoices).toHaveLength(2);
    expect(result.page.hasNextPage).toBe(false);
  });

  it("fetchInvoice GETs /invoices/<id>", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(draftInvoiceFixture()) }]);
    const fact = await fetchInvoice(makeAdapter(stub), "FIXTUREINVOICE01");
    expect(fact.externalInvoiceId).toBe("FIXTUREINVOICE01");
    expect(stub.pathOf(0)).toBe("/api/v1/invoices/FIXTUREINVOICE01");
  });

  it("createInvoice POSTs to /invoices with the built payload", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(draftInvoiceFixture()) }]);
    const adapter = makeAdapter(stub);
    const fact = await createInvoice(adapter, {
      externalClientId: "FIXTURECLIENT01",
      lineItems: [{ quantity: "10", cost: "50", notes: "Consulting — March, 10 hours" }],
    });
    expect(stub.pathOf(0)).toBe("/api/v1/invoices");
    expect(stub.calls[0]?.method).toBe("POST");
    expect(fact.status).toBe("draft");
  });

  it("updateInvoice PUTs to /invoices/<id>", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(draftInvoiceFixture()) }]);
    const adapter = makeAdapter(stub);
    await updateInvoice(adapter, "FIXTUREINVOICE01", {
      externalClientId: "FIXTURECLIENT01",
      lineItems: [{ quantity: "5", cost: "50" }],
    });
    expect(stub.pathOf(0)).toBe("/api/v1/invoices/FIXTUREINVOICE01");
    expect(stub.calls[0]?.method).toBe("PUT");
  });

  it("markInvoiceSent GETs the /mark_sent action route and returns the updated fact", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(sentInvoiceFixture()) }]);
    const adapter = makeAdapter(stub);
    const fact = await markInvoiceSent(adapter, "FIXTUREINVOICE01");
    expect(stub.pathOf(0)).toBe("/api/v1/invoices/FIXTUREINVOICE01/mark_sent");
    expect(stub.calls[0]?.method).toBe("GET");
    expect(fact.status).toBe("sent");
    expect(fact.number).toBe("INV-0001");
  });
});
