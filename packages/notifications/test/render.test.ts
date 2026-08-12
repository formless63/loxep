/**
 * Enriched market-event message rendering tests (loxep-62y.3.2): one case
 * per event type, plus listing-URL/label fallback behavior. Pure function —
 * no DB, no network.
 */
import { describe, expect, it } from "vitest";
import { renderMarketEventMessage } from "../src/render.ts";
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
