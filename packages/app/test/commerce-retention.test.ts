/**
 * The ADR-0021 redaction SEAM, exercised through the REAL adapter helpers.
 *
 * `packages/commerce/test/retention.test.ts` proves the sweep's mechanics
 * against a real database with a stub redactor. This file proves the other
 * half — that the functions the composition root injects actually remove
 * personal data — because that is the only part of the policy a wrong answer
 * silently defeats: a sweep that runs, stamps `redacted_at`, and leaves a
 * buyer's address in place looks exactly like a working one.
 *
 * No database is involved: `mapWooOrder`, `mapEbayOrder`, and both
 * `redact*OrderFact` helpers are pure.
 *
 * **The payloads below are synthetic.** They carry every personal-data FIELD
 * the live adapters documented — `billing`/`shipping`, email, phone,
 * `customer_ip_address`, `customer_user_agent`, eBay's
 * `buyerRegistrationAddress`, `taxIdentifier.taxpayerId`,
 * `fulfillmentStartInstructions[].shippingStep.shipTo`, `giftDetails`, and
 * `buyerCheckoutNotes` — with obviously fake values, so a failing assertion
 * cannot print a real person's data.
 */
import {
  EBAY_ORDER_OBJECT_TYPE,
  MEDUSA_ORDER_OBJECT_TYPE,
  WOO_ORDER_OBJECT_TYPE,
} from "@loxep/commerce";
import { describe, expect, it } from "vitest";
import { createOrderPayloadRedactors } from "../src/commerce-retention.ts";

/** Every string value anywhere in a JSON value, for leak assertions. */
function stringValues(value: unknown, sink: string[] = []): string[] {
  if (typeof value === "string") sink.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, sink);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) stringValues(item, sink);
  }
  return sink;
}

/** Assert none of the synthetic personal-data markers survived. */
function expectNoPii(redacted: unknown, markers: readonly string[]): void {
  const haystack = stringValues(redacted);
  for (const marker of markers) {
    expect(
      haystack.some((entry) => entry.includes(marker)),
      `redacted payload still contains the marker ${marker}`,
    ).toBe(false);
  }
}

const WOO_PII_MARKERS = [
  "Fixture",
  "1 Synthetic Way",
  "fixture.person@example.invalid",
  "+1-555-0100",
  "203.0.113.7",
  "SyntheticBrowser",
] as const;

function wooPayloadWithPii(): Record<string, unknown> {
  return {
    id: 5001,
    number: "5001",
    status: "completed",
    currency: "USD",
    total: "59.00",
    total_tax: "4.00",
    shipping_total: "5.00",
    discount_total: "0.00",
    date_created_gmt: "2026-01-01T12:00:00",
    date_modified_gmt: "2026-01-01T12:05:00",
    date_paid_gmt: "2026-01-01T12:01:00",
    date_completed_gmt: "2026-01-01T12:04:00",
    customer_id: 9,
    billing: {
      first_name: "Fixture",
      last_name: "Person",
      address_1: "1 Synthetic Way",
      city: "Somewhere",
      postcode: "00000",
      country: "US",
      email: "fixture.person@example.invalid",
      phone: "+1-555-0100",
    },
    shipping: {
      first_name: "Fixture",
      last_name: "Person",
      address_1: "1 Synthetic Way",
      city: "Somewhere",
      state: "NY",
      postcode: "00000",
      country: "US",
    },
    customer_ip_address: "203.0.113.7",
    customer_user_agent: "SyntheticBrowser/1.0",
    line_items: [
      {
        id: 41,
        name: "Alpha widget",
        product_id: 700,
        variation_id: 0,
        quantity: 2,
        sku: "SKU-ALPHA",
        price: 25,
        subtotal: "50.00",
        subtotal_tax: "4.00",
        total: "50.00",
        total_tax: "4.00",
        tax_class: "",
      },
    ],
    fee_lines: [],
    refunds: [],
  };
}

const EBAY_PII_MARKERS = [
  "Fixture Person",
  "2 Synthetic Road",
  "fixture.buyer@example.invalid",
  "+1-555-0199",
  "TAXPAYER-000",
  "gift.recipient@example.invalid",
  "a synthetic gift message",
  "synthetic checkout note",
] as const;

function ebayPayloadWithPii(): Record<string, unknown> {
  return {
    orderId: "07-00000-00000",
    legacyOrderId: "000000000000",
    creationDate: "2026-01-01T12:00:00.000Z",
    lastModifiedDate: "2026-01-01T12:05:00.000Z",
    orderFulfillmentStatus: "FULFILLED",
    orderPaymentStatus: "PAID",
    sellerId: "synthetic-seller",
    buyerCheckoutNotes: "a synthetic checkout note",
    buyer: {
      username: "synthetic_buyer",
      taxIdentifier: { taxpayerId: "TAXPAYER-000", taxIdentifierType: "ID" },
      buyerRegistrationAddress: {
        fullName: "Fixture Person",
        email: "fixture.buyer@example.invalid",
        primaryPhone: { phoneNumber: "+1-555-0199" },
        contactAddress: {
          addressLine1: "2 Synthetic Road",
          city: "Somewhere",
          stateOrProvince: "NY",
          postalCode: "00000",
          countryCode: "US",
        },
      },
    },
    pricingSummary: {
      total: { value: "59.00", currency: "USD" },
      priceSubtotal: { value: "50.00", currency: "USD" },
      deliveryCost: { value: "5.00", currency: "USD" },
      tax: { value: "4.00", currency: "USD" },
    },
    fulfillmentStartInstructions: [
      {
        shippingStep: {
          shipTo: {
            fullName: "Fixture Person",
            email: "fixture.buyer@example.invalid",
            primaryPhone: { phoneNumber: "+1-555-0199" },
            contactAddress: {
              addressLine1: "2 Synthetic Road",
              city: "Somewhere",
              stateOrProvince: "NY",
              postalCode: "00000",
              countryCode: "US",
            },
          },
        },
      },
    ],
    lineItems: [
      {
        lineItemId: "1",
        legacyItemId: "111111111111",
        title: "Alpha widget",
        sku: "SKU-ALPHA",
        quantity: 2,
        lineItemCost: { value: "50.00", currency: "USD" },
        total: { value: "50.00", currency: "USD" },
        taxes: [{ amount: { value: "4.00", currency: "USD" } }],
        giftDetails: {
          recipientEmail: "gift.recipient@example.invalid",
          senderName: "Fixture Person",
          message: "a synthetic gift message",
        },
      },
    ],
  };
}

const MEDUSA_PII_MARKERS = [
  "Fixture",
  "3 Synthetic Court",
  "fixture.medusa@example.invalid",
  "+1-555-0177",
] as const;

function medusaPayloadWithPii(): Record<string, unknown> {
  return {
    id: "order_01SYNTHETIC",
    display_id: 9001,
    status: "completed",
    payment_status: "partially_refunded",
    fulfillment_status: "fulfilled",
    currency_code: "usd",
    total: 25,
    original_total: 30,
    subtotal: 55,
    shipping_total: 5,
    tax_total: 4,
    discount_total: 0,
    created_at: "2026-01-01T12:00:00.000Z",
    updated_at: "2026-01-01T12:10:00.000Z",
    customer_id: "cus_SYNTHETIC",
    email: "fixture.medusa@example.invalid",
    shipping_address: {
      first_name: "Fixture",
      last_name: "Person",
      address_1: "3 Synthetic Court",
      city: "Somewhere",
      postal_code: "00000",
      country_code: "us",
      phone: "+1-555-0177",
    },
    billing_address: {
      first_name: "Fixture",
      last_name: "Person",
      address_1: "3 Synthetic Court",
      city: "Somewhere",
      postal_code: "00000",
      country_code: "us",
      phone: "+1-555-0177",
    },
    items: [
      {
        id: "ordli_01SYNTHETIC",
        title: "Alpha widget",
        variant_sku: "SKU-ALPHA",
        product_id: "prod_01SYNTHETIC",
        variant_id: "variant_01SYNTHETIC",
        quantity: 2,
        unit_price: 25,
        subtotal: 50,
        total: 50,
        tax_total: 4,
        discount_total: 0,
      },
    ],
    payment_collections: [
      {
        payments: [
          {
            captured_at: "2026-01-01T12:05:00.000Z",
            refunds: [
              {
                id: "ref_01SYNTHETIC",
                refund_reason: { label: "requested_by_customer" },
                note: null,
                amount: 5,
                created_at: "2026-01-01T12:08:00.000Z",
              },
            ],
          },
        ],
      },
    ],
    fulfillments: [],
  };
}

describe("createOrderPayloadRedactors", () => {
  const redactors = createOrderPayloadRedactors();

  it("covers exactly the order classes this composition can ingest", () => {
    expect(Object.keys(redactors).sort()).toEqual(
      [
        WOO_ORDER_OBJECT_TYPE,
        EBAY_ORDER_OBJECT_TYPE,
        MEDUSA_ORDER_OBJECT_TYPE,
      ].sort(),
    );
  });

  describe("woocommerce.order", () => {
    const redact = redactors[WOO_ORDER_OBJECT_TYPE]!;

    it("removes every personal-data field from a stored payload", () => {
      const redacted = redact(wooPayloadWithPii());
      expectNoPii(redacted, WOO_PII_MARKERS);
      expect(redacted["raw"]).toBe("[redacted]");
    });

    it("keeps the order economics that make the payload worth retaining", () => {
      const redacted = redact(wooPayloadWithPii()) as Record<string, unknown>;
      expect(redacted["externalOrderId"]).toBe("5001");
      // Adapter facts keep the provider's own precision; the 6-decimal
      // scaling happens later, in the commerce translation.
      expect(redacted["totals"]).toMatchObject({
        total: "59.00",
        shipping: "5.00",
        tax: "4.00",
      });
      expect(Array.isArray(redacted["lineItems"])).toBe(true);
      expect((redacted["lineItems"] as unknown[]).length).toBe(1);
    });

    it("is total on its own output (at-least-once safety)", () => {
      const once = redact(wooPayloadWithPii());
      const twice = redact(once);
      expect(twice).toEqual(once);
    });

    it("produces a JSON-serializable object for the jsonb column", () => {
      const redacted = redact(wooPayloadWithPii());
      expect(() => JSON.stringify(redacted)).not.toThrow();
      expect(JSON.parse(JSON.stringify(redacted))).toEqual(redacted);
    });
  });

  describe("ebay.order", () => {
    const redact = redactors[EBAY_ORDER_OBJECT_TYPE]!;

    it("removes every personal-data field from a stored payload", () => {
      const redacted = redact(ebayPayloadWithPii());
      expectNoPii(redacted, EBAY_PII_MARKERS);
      expect(redacted["raw"]).toBe("[redacted]");
    });

    it("keeps the eBay username, which is a channel handle and not a name", () => {
      const redacted = redact(ebayPayloadWithPii());
      expect(redacted["buyerExternalId"]).toBe("synthetic_buyer");
      expect(redacted["externalOrderId"]).toBe("07-00000-00000");
    });

    it("is total on its own output (at-least-once safety)", () => {
      const once = redact(ebayPayloadWithPii());
      const twice = redact(once);
      expect(twice).toEqual(once);
    });

    it("produces a JSON-serializable object for the jsonb column", () => {
      const redacted = redact(ebayPayloadWithPii());
      expect(() => JSON.stringify(redacted)).not.toThrow();
      expect(JSON.parse(JSON.stringify(redacted))).toEqual(redacted);
    });
  });

  describe("medusa.order", () => {
    const redact = redactors[MEDUSA_ORDER_OBJECT_TYPE]!;

    it("removes every personal-data field from a stored payload", () => {
      const redacted = redact(medusaPayloadWithPii());
      expectNoPii(redacted, MEDUSA_PII_MARKERS);
      expect(redacted["raw"]).toBe("[redacted]");
    });

    it("keeps the order economics that make the payload worth retaining", () => {
      const redacted = redact(medusaPayloadWithPii()) as Record<string, unknown>;
      expect(redacted["externalOrderId"]).toBe("order_01SYNTHETIC");
      // originalTotal, not total — mapping #1, unaffected by the refund.
      expect(redacted["totals"]).toMatchObject({
        total: "25",
        originalTotal: "30",
        shipping: "5",
        tax: "4",
        refunded: "5",
      });
      expect(Array.isArray(redacted["lineItems"])).toBe(true);
      expect((redacted["lineItems"] as unknown[]).length).toBe(1);
      // The customer id is an opaque handle, not personal data — kept, same
      // reasoning as eBay's username.
      expect(redacted["buyerExternalId"]).toBe("cus_SYNTHETIC");
    });

    it("is total on its own output (at-least-once safety)", () => {
      const once = redact(medusaPayloadWithPii());
      const twice = redact(once);
      expect(twice).toEqual(once);
    });

    it("produces a JSON-serializable object for the jsonb column", () => {
      const redacted = redact(medusaPayloadWithPii());
      expect(() => JSON.stringify(redacted)).not.toThrow();
      expect(JSON.parse(JSON.stringify(redacted))).toEqual(redacted);
    });
  });
});
