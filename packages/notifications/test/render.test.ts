/**
 * Enriched market-event message rendering tests (loxep-62y.3.2): one case
 * per event type, plus listing-URL/label fallback behavior. Pure function —
 * no DB, no network.
 */
import { describe, expect, it } from "vitest";
import {
  renderMarketEventMessage,
  renderNotificationEventMessage,
} from "../src/render.ts";
import type { RenderableMarketEvent } from "../src/render.ts";

const baseEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  marketplaceItemId: "22222222-2222-4222-8222-222222222222",
  monitorTargetId: null,
  toObservedAt: new Date("2026-08-10T12:00:00.000Z"),
} satisfies Partial<RenderableMarketEvent>;

const listing = {
  provider: "ebay",
  marketplace: "EBAY_US",
  externalItemId: "v1|123456789|0",
  canonicalUrl: "https://www.ebay.com/itm/123456789",
  title: "Vintage Widget 3000",
};

describe("renderMarketEventMessage", () => {
  it("renders price_changed with old→new price and the listing URL", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_changed",
      payload: { from: "20.00", to: "25.00", currency: "USD" },
      listing,
    });
    expect(message.title).toBe("Price changed: Vintage Widget 3000");
    expect(message.body).toBe(
      "Vintage Widget 3000: $20.00 → $25.00\nhttps://www.ebay.com/itm/123456789",
    );
    expect(message.tags).toEqual(["price_changed"]);
    expect(message.priority).toBe("default");
    // The listing URL is also set as the click-through target, not just the
    // trailing body line.
    expect(message.url).toBe("https://www.ebay.com/itm/123456789");
  });

  it("renders price_dropped as high priority with the price delta", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_dropped",
      payload: { from: "20.00", to: "15.00", currency: "USD" },
      listing,
    });
    expect(message.title).toBe("Price drop: Vintage Widget 3000");
    expect(message.body).toContain("$20.00 → $15.00");
    expect(message.body).toContain("https://www.ebay.com/itm/123456789");
    expect(message.priority).toBe("high");
    expect(message.tags).toEqual(["price_dropped", "moneybag"]);
  });

  it("normalizes an unrounded numeric(20,6) price to the same scale as an already-trimmed one", () => {
    // Regression for the live push that read '49.990000 USD -> 34.99 USD':
    // the raw DB scale (6 fraction digits) and an already-trimmed value must
    // render identically once both go through formatMoney.
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_dropped",
      payload: { from: "49.990000", to: "34.99", currency: "USD" },
      listing,
    });
    expect(message.body).toContain("$49.99 → $34.99");
  });

  it("normalizes '12.5' and '12.50' to the same two-decimal display", () => {
    const a = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_changed",
      payload: { from: "12.5", to: "12.5", currency: "USD" },
      listing,
    });
    const b = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_changed",
      payload: { from: "12.50", to: "12.50", currency: "USD" },
      listing,
    });
    expect(a.body).toContain("$12.50 → $12.50");
    expect(a.body).toBe(b.body);
  });

  it("renders a plain normalized decimal (no fabricated currency) when currency is null", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_changed",
      payload: { from: "20", to: "15.5", currency: null },
      listing,
    });
    expect(message.body).toContain("20.00 → 15.50");
    expect(message.body).not.toContain("USD");
    expect(message.body).not.toContain("$");
  });

  it("does not set a click url when the listing has no canonical URL", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_dropped",
      payload: { from: "20.00", to: "15.00", currency: "USD" },
      listing: { ...listing, canonicalUrl: null },
    });
    expect(message.url).toBeUndefined();
  });

  it("renders quantity_changed with the old→new quantity", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "quantity_changed",
      payload: { from: 5, to: 2 },
      listing,
    });
    expect(message.title).toBe("Quantity changed: Vintage Widget 3000");
    expect(message.body).toBe(
      "Vintage Widget 3000: quantity 5 → 2\nhttps://www.ebay.com/itm/123456789",
    );
  });

  it("renders restocked with the quantity delta when present", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "restocked",
      payload: {
        fromQuantity: 0,
        toQuantity: 3,
        fromAvailability: "out_of_stock",
        toAvailability: "in_stock",
      },
      listing,
    });
    expect(message.title).toBe("Back in stock: Vintage Widget 3000");
    expect(message.body).toBe(
      "Vintage Widget 3000 is back in stock (qty 0 → 3)\nhttps://www.ebay.com/itm/123456789",
    );
    expect(message.priority).toBe("high");
  });

  it("renders restocked without a quantity delta when only availability flipped", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "restocked",
      payload: {
        fromQuantity: null,
        toQuantity: null,
        fromAvailability: "out_of_stock",
        toAvailability: "in_stock",
      },
    });
    expect(message.body).toBe("item 22222222-2222-4222-8222-222222222222 is back in stock");
  });

  it("renders sold_out with the prior quantity when present", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "sold_out",
      payload: {
        fromQuantity: 4,
        toQuantity: 0,
        fromAvailability: "in_stock",
        toAvailability: "out_of_stock",
      },
      listing,
    });
    expect(message.title).toBe("Sold out: Vintage Widget 3000");
    expect(message.body).toBe(
      "Vintage Widget 3000 is now sold out (was qty 4)\nhttps://www.ebay.com/itm/123456789",
    );
  });

  it("renders listing_ended with the prior listing state", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "listing_ended",
      payload: { from: "active", to: "ended" },
      listing,
    });
    expect(message.title).toBe("Listing ended: Vintage Widget 3000");
    expect(message.body).toBe(
      'Vintage Widget 3000: listing ended (was "active")\nhttps://www.ebay.com/itm/123456789',
    );
  });

  it("falls back to a generic item label and no URL line when listing is omitted", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_dropped",
      payload: { from: "20.00", to: "15.00", currency: "USD" },
    });
    expect(message.body).toBe(
      "item 22222222-2222-4222-8222-222222222222: $20.00 → $15.00",
    );
    expect(message.body).not.toContain("\n");
    expect(message.url).toBeUndefined();
  });

  it("ignores a null canonicalUrl and a blank title rather than fabricating either", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "sold_out",
      payload: {},
      listing: { ...listing, canonicalUrl: null, title: "  " },
    });
    expect(message.body).toBe(
      "item 22222222-2222-4222-8222-222222222222 is now sold out",
    );
  });

  it("falls back to the plain rendering shape for an unrecognized event type", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "custom_event",
      payload: { note: "future event type" },
      listing,
    });
    expect(message.title).toBe("Loxep: custom event");
    expect(message.body).toBe(
      "custom_event for Vintage Widget 3000 at 2026-08-10T12:00:00.000Z\nhttps://www.ebay.com/itm/123456789",
    );
    expect(message.tags).toEqual(["custom_event"]);
  });
});

describe("new_listing (the discovery event)", () => {
  it("renders title, price, and the payload's own canonical URL without a joined listing", () => {
    // Discovery records title/price/currency/canonicalUrl in the payload at
    // link time, so this event renders fully with NO joined listing row —
    // the case that previously fell through to the ISO-timestamp default.
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "new_listing",
      payload: {
        title: "Rare Widget MkII",
        price: "149.990000",
        currency: "USD",
        canonicalUrl: "https://www.ebay.com/itm/987654321",
        discoveredByMonitorTargetId: "33333333-3333-4333-8333-333333333333",
      },
    });
    expect(message.title).toBe("New listing: Rare Widget MkII");
    expect(message.body).toBe(
      "Rare Widget MkII — $149.99\nhttps://www.ebay.com/itm/987654321",
    );
    expect(message.url).toBe("https://www.ebay.com/itm/987654321");
    expect(message.tags).toContain("new_listing");
    expect(message.priority).toBe("high");
  });

  it("renders an end time when the listing carries one", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "new_listing",
      payload: {
        title: "Ending Soon Widget",
        listingEndsAt: "2026-08-20T09:00:00.000Z",
      },
    });
    expect(message.body).toContain("Ends 2026-08-20T09:00:00.000Z");
  });
});

describe("opportunity attribution reaches the message", () => {
  it("puts the attributing rule's name in the title and its score in the body", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_dropped",
      payload: {
        from: "100.00",
        to: "60.00",
        currency: "USD",
        opportunity: {
          ruleId: "44444444-4444-4444-8444-444444444444",
          ruleName: "Deep discounts",
          priority: 10,
          score: 82.5,
          reasons: ["discount: 40%", "price: under $75"],
          matchCount: 1,
          evaluatedAt: "2026-08-10T12:00:01.000Z",
        },
      },
      listing,
    });
    expect(message.title).toBe("Deep discounts: Price drop: Vintage Widget 3000");
    expect(message.body).toContain("Opportunity: Deep discounts (score 82.5)");
    expect(message.body).toContain("discount: 40%");
    expect(message.tags).toContain("opportunity");
    expect(message.priority).toBe("high");
  });

  it("leaves an unattributed event untouched", () => {
    const message = renderMarketEventMessage({
      ...baseEvent,
      eventType: "price_dropped",
      payload: { from: "100.00", to: "60.00", currency: "USD" },
      listing,
    });
    expect(message.title).toBe("Price drop: Vintage Widget 3000");
    expect(message.body).not.toContain("Opportunity");
    expect(message.tags).not.toContain("opportunity");
  });
});

describe("renderNotificationEventMessage (classes beyond market)", () => {
  const baseRow = {
    id: "55555555-5555-4555-8555-555555555555",
    monitorTargetId: null,
    occurredAt: new Date("2026-08-14T08:30:00.000Z"),
    deduplicationKey: "test",
    createdAt: new Date("2026-08-14T08:30:00.000Z"),
  };

  it("renders a market-class row through the market renderer", () => {
    const message = renderNotificationEventMessage({
      ...baseRow,
      eventClass: "market",
      eventType: "restocked",
      subjectType: "market_event",
      subjectId: "66666666-6666-4666-8666-666666666666",
      payload: {
        marketplaceItemId: "22222222-2222-4222-8222-222222222222",
        fromQuantity: 0,
        toQuantity: 3,
        title: "Vintage Widget 3000",
      },
    } as never);
    expect(message.title).toBe("Back in stock: Vintage Widget 3000");
  });

  it("renders a purchase", () => {
    const message = renderNotificationEventMessage({
      ...baseRow,
      eventClass: "purchase",
      eventType: "purchase_ingested",
      subjectType: "acquisition",
      subjectId: "77777777-7777-4777-8777-777777777777",
      payload: {
        referenceCode: "ACQ-2026-0042",
        totalAmount: "89.500000",
        currency: "USD",
      },
    } as never);
    expect(message.title).toBe("Purchase ACQ-2026-0042 ingested");
    expect(message.body).toContain("Total $89.50");
    expect(message.body).toContain("Awaiting intake");
  });

  it("renders a document confirmation", () => {
    const message = renderNotificationEventMessage({
      ...baseRow,
      eventClass: "document",
      eventType: "document_confirmed",
      subjectType: "document",
      subjectId: "88888888-8888-4888-8888-888888888888",
      payload: { fileName: "receipt-aug.pdf", lineCount: 3 },
    } as never);
    expect(message.title).toBe("Document confirmed: receipt-aug.pdf");
    expect(message.body).toContain("3 lines");
  });

  it("renders a manual sale", () => {
    const message = renderNotificationEventMessage({
      ...baseRow,
      eventClass: "sale",
      eventType: "manual_sale_recorded",
      subjectType: "order",
      subjectId: "99999999-9999-4999-8999-999999999999",
      payload: {
        listingTitle: "Vintage Widget 3000",
        totalAmount: "125.000000",
        currency: "USD",
        quantity: 2,
      },
    } as never);
    expect(message.title).toBe("Sale recorded: Vintage Widget 3000");
    expect(message.body).toBe("Vintage Widget 3000 x2 sold for $125.00.");
    expect(message.priority).toBe("high");
  });

  it("renders a health degradation and a recovery differently", () => {
    const degraded = renderNotificationEventMessage({
      ...baseRow,
      eventClass: "health",
      eventType: "health_degraded",
      subjectType: "connection",
      subjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      payload: {
        subjectType: "connection",
        previousStatus: "ok",
        status: "failing",
        detail: { provider: "ebay" },
      },
    } as never);
    expect(degraded.title).toBe("Degraded: Connection (ebay)");
    expect(degraded.body).toContain("ok → failing");
    expect(degraded.priority).toBe("high");

    const recovered = renderNotificationEventMessage({
      ...baseRow,
      eventClass: "health",
      eventType: "health_recovered",
      subjectType: "storage_backend",
      subjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      payload: {
        subjectType: "storage_backend",
        previousStatus: "failing",
        status: "ok",
        detail: {},
      },
    } as never);
    expect(recovered.title).toBe("Recovered: Storage backend");
    expect(recovered.priority).toBe("default");
  });

  it("falls back readably for a class it does not know", () => {
    const message = renderNotificationEventMessage({
      ...baseRow,
      eventClass: "infrastructure",
      eventType: "dns_drift_found",
      subjectType: "managed_domain",
      subjectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      payload: {},
    } as never);
    expect(message.title).toBe("Loxep: dns drift found");
    expect(message.body).toContain("managed_domain");
  });
});
