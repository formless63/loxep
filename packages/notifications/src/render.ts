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
import type { NotificationEventRow } from "@loxep/domain";
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

/**
 * Only a real known `canonical_url` is used — never a synthesized guess. The
 * joined `marketplace_items` row wins; `new_listing` events carry the same
 * fact in their own payload (discovery records it at link time), so that is
 * the fallback rather than nothing.
 */
function listingUrl(
  listing: RenderableListingItem | null | undefined,
  payload: Record<string, unknown>,
): string | null {
  const url = listing?.canonicalUrl;
  if (typeof url === "string" && url.length > 0) return url;
  const fromPayload = payload["canonicalUrl"];
  return typeof fromPayload === "string" && fromPayload.length > 0
    ? fromPayload
    : null;
}

function itemLabel(
  event: RenderableMarketEvent,
  payload: Record<string, unknown>,
): string {
  const title = event.listing?.title;
  if (typeof title === "string" && title.trim().length > 0) return title.trim();
  const fromPayload = payload["title"];
  if (typeof fromPayload === "string" && fromPayload.trim().length > 0) {
    return fromPayload.trim();
  }
  return `item ${event.marketplaceItemId}`;
}

/**
 * `marketplace_item_observations` prices are PostgreSQL `numeric(20,6)` and
 * arrive here as decimal strings — never round-tripped through JS float
 * arithmetic. `Number(value)` below is used ONLY to feed `Intl.NumberFormat`
 * for display; the decimal string itself remains the source of truth
 * upstream. This mirrors the intent of apps/web `lib/format.ts`'s
 * `formatMoney` (trim to canonical display scale, symbol/code placement via
 * `Intl` on a fixed `en-US` locale) reimplemented locally because that
 * module lives in `apps/web` and is not importable from a package.
 *
 * "12.5" and "12.50" normalize to the same two-decimal display, and a raw
 * `49.990000` normalizes identically to an already-trimmed `34.99` so old
 * and new prices in the same message never show a mismatched scale.
 */
function formatMoney(value: unknown, currency: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  const trimmedCurrency =
    typeof currency === "string" && currency.trim().length > 0
      ? currency.trim()
      : null;

  if (trimmedCurrency !== null) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: trimmedCurrency,
      }).format(numeric);
    } catch {
      // Invalid/unrecognized currency code — fall through to plain decimal
      // rather than throwing on a bad or legacy provider currency string.
    }
  }

  return new Intl.NumberFormat("en-US", {
    style: "decimal",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
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
  const label = itemLabel(event, payload);
  const url = listingUrl(event.listing, payload);
  const rendered = withOpportunity(renderBody(event, payload, label, url), payload);
  // The URL stays in the body too (clients without click-action support);
  // this additionally sets it as the transport's click-through target.
  return url === null ? rendered : { ...rendered, url };
}

/**
 * `@loxep/market`'s opportunity evaluator stamps `market_events.rule_id` and
 * merges a namespaced `opportunity` block into the event payload
 * (`OPPORTUNITY_PAYLOAD_KEY`) carrying the attributing rule's name, priority,
 * score, and reasons. Before this, none of it reached the message: an
 * operator got a bare "price drop" and had to open the app to learn WHICH of
 * their rules considered it an opportunity, and how strongly.
 *
 * An attributed event is by definition one the operator asked to be told
 * about, so it also carries a `high` priority unless the renderer already set
 * one.
 */
function withOpportunity(
  message: NotificationMessage,
  payload: Record<string, unknown>,
): NotificationMessage {
  const block = payload["opportunity"];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return message;
  }
  const opportunity = block as Record<string, unknown>;
  const ruleName = opportunity["ruleName"];
  if (typeof ruleName !== "string" || ruleName.trim().length === 0) {
    return message;
  }
  const name = ruleName.trim();
  const score = opportunity["score"];
  const scorePart =
    typeof score === "number" && Number.isFinite(score)
      ? ` (score ${new Intl.NumberFormat("en-US", {
          maximumFractionDigits: 2,
        }).format(score)})`
      : "";
  const reasons = Array.isArray(opportunity["reasons"])
    ? (opportunity["reasons"] as unknown[])
        .filter((reason): reason is string => typeof reason === "string")
        .slice(0, 3)
    : [];
  const reasonLines = reasons.length === 0 ? "" : `\n${reasons.join("\n")}`;
  return {
    ...message,
    title: `${name}: ${message.title}`,
    body: `${message.body}\nOpportunity: ${name}${scorePart}${reasonLines}`,
    tags: [...(message.tags ?? []), "opportunity"],
    priority: message.priority ?? "high",
  };
}

function renderBody(
  event: RenderableMarketEvent,
  payload: Record<string, unknown>,
  label: string,
  url: string | null,
): NotificationMessage {
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
    case "new_listing": {
      // The one DISCOVERY event, and the one an operator most wants enriched:
      // before this it fell through to the generic ISO-timestamp default.
      // Discovery records title/price/currency/canonicalUrl in the payload at
      // link time, so this renders fully even with no joined listing row.
      const price = formatMoney(payload["price"], payload["currency"]);
      const pricePart = price === null ? "" : ` — ${price}`;
      const endsAt = payload["listingEndsAt"];
      const endsPart =
        typeof endsAt === "string" && endsAt.length > 0
          ? `\nEnds ${endsAt}`
          : "";
      return {
        title: `New listing: ${label}`,
        body: withUrlLine(`${label}${pricePart}${endsPart}`, url),
        tags: ["new_listing", "sparkles"],
        priority: "high",
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

// ---------------------------------------------------------------------------
// Notification events (ADR-0023): rendering beyond the market class
// ---------------------------------------------------------------------------

/**
 * Rebuild the market projection from a `market`-class notification event.
 *
 * The emitting bridge copies the market event's own payload plus
 * `marketplaceItemId` into the notification payload, so rendering needs no
 * join and an injected `renderMessage` (the composition root's listing-context
 * enrichment) keeps working exactly as it did against a `market_events` row.
 */
export function marketEventFromNotificationEvent(
  event: NotificationEventRow,
): RenderableMarketEvent {
  const payload = payloadRecord(event.payload);
  const marketplaceItemId = payload["marketplaceItemId"];
  return {
    id: event.subjectId,
    marketplaceItemId:
      typeof marketplaceItemId === "string" ? marketplaceItemId : "",
    eventType: event.eventType,
    monitorTargetId: event.monitorTargetId,
    toObservedAt: event.occurredAt,
    payload,
  };
}

function moneyOrNull(payload: Record<string, unknown>, key: string): string | null {
  return formatMoney(payload[key], payload["currency"]);
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

const HEALTH_SUBJECT_LABELS: Record<string, string> = {
  connection: "Connection",
  notification_endpoint: "Notification endpoint",
  storage_backend: "Storage backend",
};

/**
 * Title/body/tags for any recorded notification event, market included.
 *
 * Pure over `(event_class, event_type, payload)` — no database, no I/O — so
 * the same function renders the outbound message and the in-app feed, and
 * improving it improves the rendering of events recorded before it. A class or
 * type this renderer does not know falls back to a readable generic line
 * rather than to raw JSON.
 */
export function renderNotificationEventMessage(
  event: NotificationEventRow,
): NotificationMessage {
  if (event.eventClass === "market") {
    return renderMarketEventMessage(marketEventFromNotificationEvent(event));
  }
  const payload = payloadRecord(event.payload);

  switch (event.eventClass) {
    case "purchase": {
      const reference = formatUnknown(payload["referenceCode"], "");
      const label =
        reference.length > 0
          ? `Purchase ${reference}`
          : `Purchase ${shortId(event.subjectId)}`;
      const total = moneyOrNull(payload, "totalAmount");
      const seller = formatUnknown(payload["sellerName"], "");
      const lines = [
        total === null ? null : `Total ${total}`,
        seller.length > 0 ? `Seller ${seller}` : null,
        "Awaiting intake in Inventory.",
      ].filter((line): line is string => line !== null);
      return {
        title: `${label} ingested`,
        body: lines.join("\n"),
        tags: ["purchase_ingested", "package"],
      };
    }
    case "document": {
      const name = formatUnknown(payload["fileName"], "");
      const label = name.length > 0 ? name : `Document ${shortId(event.subjectId)}`;
      const lineCount = payload["lineCount"];
      const linePart =
        typeof lineCount === "number"
          ? ` (${lineCount} line${lineCount === 1 ? "" : "s"})`
          : "";
      return {
        title: `Document confirmed: ${label}`,
        body: `${label} is confirmed${linePart}.`,
        tags: ["document_confirmed", "white_check_mark"],
      };
    }
    case "sale": {
      const listing = formatUnknown(payload["listingTitle"], "");
      const label = listing.length > 0 ? listing : `order ${shortId(event.subjectId)}`;
      const amount = moneyOrNull(payload, "totalAmount");
      const quantity = payload["quantity"];
      const quantityPart =
        typeof quantity === "number" && quantity > 1 ? ` x${quantity}` : "";
      const amountPart = amount === null ? "" : ` for ${amount}`;
      return {
        title: `Sale recorded: ${label}`,
        body: `${label}${quantityPart} sold${amountPart}.`,
        tags: ["manual_sale_recorded", "moneybag"],
        priority: "high",
      };
    }
    case "health": {
      const subjectType = formatUnknown(payload["subjectType"], event.subjectType);
      const subjectLabel =
        HEALTH_SUBJECT_LABELS[subjectType] ?? subjectType.replaceAll("_", " ");
      const previous = formatUnknown(payload["previousStatus"], "unknown");
      const status = formatUnknown(payload["status"], "unknown");
      const recovered = event.eventType === "health_recovered";
      const detail = payloadRecord(payload["detail"]);
      const provider = formatUnknown(detail["provider"], "");
      const name = provider.length > 0 ? ` (${provider})` : "";
      return {
        title: recovered
          ? `Recovered: ${subjectLabel}${name}`
          : `Degraded: ${subjectLabel}${name}`,
        body:
          `${subjectLabel} ${shortId(event.subjectId)}${name}: ` +
          `${previous} → ${status}`,
        tags: [event.eventType, recovered ? "white_check_mark" : "warning"],
        priority: recovered ? "default" : "high",
      };
    }
    default: {
      return {
        title: `Loxep: ${event.eventType.replaceAll("_", " ")}`,
        body:
          `${event.eventType} for ${event.subjectType} ` +
          `${shortId(event.subjectId)} at ${event.occurredAt.toISOString()}`,
        tags: [event.eventType],
      };
    }
  }
}
