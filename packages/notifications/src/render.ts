/**
 * Enriched market-event message rendering (loxep-62y.3.2).
 *
 * `deliver.ts`'s `renderMarketEventMessage` is deliberately plain in Phase 0
 * (event type + item id + raw payload JSON). This module produces a richer,
 * per-event-type title/body — the canonical listing URL plus the useful
 * delta for the event (price old→new, quantity old→new, availability/state
 * transitions) — while staying a pure function so it is trivially unit
 * testable (no DB, no I/O).
 *
 * `RenderableMarketEvent` is a superset of `deliver.ts`'s
 * `DeliverableMarketEvent`: every existing market-event row satisfies it
 * structurally (the extra `listing` field is optional), so this is additive,
 * not a restructure. A caller that has already joined the event's
 * `marketplace_items` row (title, canonical_url) can pass it through
 * `listing` to get the URL/title in the message; without it the message
 * still renders correctly, just without a URL line and with a generic item
 * label. Wire this in as the delivery pipeline's `renderMessage` via
 * `createDeliveryPipeline({ renderMessage: renderMarketEventMessage })` once
 * the call site has listing context available.
 */
import type { NotificationMessage } from "./transport.ts";

/** The `marketplace_items` fields needed to build a listing URL/label. */
export interface RenderableListingItem {
  provider: string;
  marketplace: string;
  externalItemId: string;
  /** `marketplace_items.canonical_url` (eBay `itemWebUrl`), when known. */
  canonicalUrl: string | null;
  title: string | null;
}

/** The market-event facts this renderer needs (mirrors `DeliverableMarketEvent`). */
export interface RenderableMarketEvent {
  id: string;
  marketplaceItemId: string;
  eventType: string;
  monitorTargetId: string | null;
  toObservedAt: Date;
  payload: unknown;
  /** Listing context for the URL/title; omit or pass `null` when unavailable. */
  listing?: RenderableListingItem | null;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/** Only a real known `canonical_url` is used — never a synthesized guess. */
function listingUrl(listing: RenderableListingItem | null | undefined): string | null {
  const url = listing?.canonicalUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function itemLabel(event: RenderableMarketEvent): string {
  const title = event.listing?.title;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : `item ${event.marketplaceItemId}`;
}

function formatMoney(value: unknown, currency: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const suffix =
    typeof currency === "string" && currency.length > 0 ? ` ${currency}` : "";
  return `${value}${suffix}`;
}

function formatUnknown(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return fallback;
}

function withUrlLine(body: string, url: string | null): string {
  return url === null ? body : `${body}\n${url}`;
}

/**
 * Per-event-type title/body/tags, including the canonical listing URL (when
 * `event.listing` carries one) and the useful delta for the event type.
 * Unknown event types fall back to `deliver.ts`'s plain rendering shape.
 */
export function renderMarketEventMessage(
  event: RenderableMarketEvent,
): NotificationMessage {
  const payload = payloadRecord(event.payload);
  const label = itemLabel(event);
  const url = listingUrl(event.listing);

  switch (event.eventType) {
    case "price_changed":
    case "price_dropped": {
      const dropped = event.eventType === "price_dropped";
      const from = formatMoney(payload["from"], payload["currency"]);
      const to = formatMoney(payload["to"], payload["currency"]);
      const delta = from !== null && to !== null ? `${from} → ${to}` : "price changed";
      return {
        title: dropped ? `Price drop: ${label}` : `Price changed: ${label}`,
        body: withUrlLine(`${label}: ${delta}`, url),
        tags: dropped ? ["price_dropped", "moneybag"] : ["price_changed"],
        priority: dropped ? "high" : "default",
      };
    }
    case "quantity_changed": {
      const from = formatUnknown(payload["from"], "?");
      const to = formatUnknown(payload["to"], "?");
      return {
        title: `Quantity changed: ${label}`,
        body: withUrlLine(`${label}: quantity ${from} → ${to}`, url),
        tags: ["quantity_changed"],
      };
    }
    case "restocked": {
      const fromQty = payload["fromQuantity"];
      const toQty = payload["toQuantity"];
      const qtyPart =
        toQty !== undefined && toQty !== null
          ? ` (qty ${formatUnknown(fromQty, "0")} → ${formatUnknown(toQty, "?")})`
          : "";
      return {
        title: `Back in stock: ${label}`,
        body: withUrlLine(`${label} is back in stock${qtyPart}`, url),
        tags: ["restocked", "white_check_mark"],
        priority: "high",
      };
    }
    case "sold_out": {
      const fromQty = payload["fromQuantity"];
      const qtyPart =
        fromQty !== undefined && fromQty !== null
          ? ` (was qty ${formatUnknown(fromQty, "?")})`
          : "";
      return {
        title: `Sold out: ${label}`,
        body: withUrlLine(`${label} is now sold out${qtyPart}`, url),
        tags: ["sold_out"],
      };
    }
    case "listing_ended": {
      const from = formatUnknown(payload["from"], "active");
      return {
        title: `Listing ended: ${label}`,
        body: withUrlLine(`${label}: listing ended (was "${from}")`, url),
        tags: ["listing_ended"],
      };
    }
    default: {
      return {
        title: `Loxep: ${event.eventType.replaceAll("_", " ")}`,
        body: withUrlLine(
          `${event.eventType} for ${label} at ${event.toObservedAt.toISOString()}`,
          url,
        ),
        tags: [event.eventType],
      };
    }
  }
}
