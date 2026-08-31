/**
 * Invoice read/write adapter: Invoice Ninja v5 `/api/v1/invoices` normalized
 * to/from Loxep-owned facts, aligned to the Services & Billing Schema
 * Design's invoice model and its `external_resources` vocabulary
 * (`provider='invoiceninja' external_type='invoice' resource_type='invoice'
 * purpose='delivery_document'`) — Loxep owns the source facts, the decision
 * that a fact was billed, the seller entity, the counterparty, and the
 * amounts; Invoice Ninja owns rendering, delivery, and the customer-visible
 * number (`numbering_source = 'external'` in the design's `invoices` table).
 *
 * SOURCE-VERIFIED against `App\Models\Invoice` (status constants),
 * `App\Transformers\InvoiceTransformer::transform()`,
 * `App\Transformers\InvoiceInvitationTransformer::transform()`,
 * `App\DataMapper\InvoiceItem` (line-item field names),
 * `App\Http\Controllers\InvoiceController::performAction()`, and
 * `routes/api.php` (`invoiceninja/invoiceninja`, `v5-stable` branch, fetched
 * 2026-08-13). This module is SOURCE- AND FIXTURE-VERIFIED. Authenticated
 * live verification remains pending, including whether a created invoice
 * carries an auto-assigned `number` and populated `invitations[].link` by
 * default.
 *
 * ## The push flow this module implements (design doc's round-trip)
 *
 * ```text
 * Loxep invoice (status='approved', numbering_source='external')
 *    --(buildInvoiceNinjaInvoicePayload + createInvoice)-->  Ninja invoice (draft)
 *    <--(external_number = .number, portalUrl = .invitations[0].link)--
 *    --(markInvoiceSent)-------------------------------------------->  Ninja invoice (sent)
 *    <--(status = .status_id, external_balance_amount = .balance)----
 * ```
 *
 * `number` is deliberately OMITTED from the create payload — Invoice Ninja
 * assigns it from the company's own numbering pattern/counter
 * (`GeneratesCounter::getNextInvoiceNumber()`, source above), which is
 * exactly what `numbering_source = 'external'` means: Loxep never mints a
 * customer-visible number here. A created invoice defaults to
 * `status_id = STATUS_DRAFT`; `markInvoiceSent` is the design's
 * "push happens at approved → issued, never from a draft" transition —
 * calling it is a separate, explicit step from `createInvoice`, matching the
 * design's rule literally.
 *
 * ## `status_id` arrives as a STRING, not a number
 *
 * `InvoiceTransformer` casts it `(string) ($invoice->status_id ?: '1')` —
 * the wire value is `"1"`..`"6"`, not `1`..`6`. {@link INVOICENINJA_INVOICE_STATUS_MAP}
 * keys on the string form.
 *
 * ## Field sources
 *
 * ```text
 * externalInvoiceId   ← id                   hashids-encoded opaque string
 * externalClientId    ← client_id
 * number              ← number               '' until Ninja assigns one — see above
 * statusIdRaw         ← status_id             STRING "1".."6" — see above
 * amount              ← amount                DECIMAL — see money.ts
 * balance             ← balance               DECIMAL — the design's external_balance_amount
 * paidToDate           ← paid_to_date          DECIMAL
 * issueOn              ← date                  'YYYY-MM-DD' or '' — Ninja's own date format
 * dueOn                ← due_date              'YYYY-MM-DD' or ''
 * poNumber              ← po_number
 * isDeleted             ← is_deleted
 * updatedAt             ← updated_at           Unix SECONDS — see clients.ts
 * portalUrl             ← invitations[0].link  '' until Ninja generates one (default-included)
 * ```
 */
import type { InvoiceNinjaAdapter, InvoiceNinjaQuery } from "./adapter.ts";
import { InvoiceNinjaAdapterError } from "./errors.ts";
import { decimalFromUnknown, numberFromDecimal } from "./money.ts";
import { isoFromInvoiceNinjaTimestamp } from "./clients.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record !== null) out.push(record);
  }
  return out;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const ZERO = "0.00";

/** `App\Models\Invoice` status constants — source-verified, see module doc. */
export const INVOICENINJA_NATIVE_INVOICE_STATUSES = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
] as const;
export type InvoiceNinjaNativeInvoiceStatus =
  (typeof INVOICENINJA_NATIVE_INVOICE_STATUSES)[number];

/** Design candidate union — mirrors `App\Models\Invoice`'s own naming closely. */
export const INVOICENINJA_INVOICE_STATUSES = [
  "draft",
  "sent",
  "partial",
  "paid",
  "cancelled",
  "reversed",
] as const;
export type InvoiceNinjaInvoiceStatus =
  (typeof INVOICENINJA_INVOICE_STATUSES)[number];

export const INVOICENINJA_INVOICE_STATUS_MAP: Readonly<
  Record<InvoiceNinjaNativeInvoiceStatus, InvoiceNinjaInvoiceStatus>
> = {
  "1": "draft",
  "2": "sent",
  "3": "partial",
  "4": "paid",
  "5": "cancelled",
  "6": "reversed",
};

function isNativeInvoiceStatus(
  value: string,
): value is InvoiceNinjaNativeInvoiceStatus {
  return (INVOICENINJA_NATIVE_INVOICE_STATUSES as readonly string[]).includes(
    value,
  );
}

export interface InvoiceNinjaLineItemFact {
  quantity: string;
  /** DECIMAL string — the unit price Ninja calls `cost`. */
  cost: string;
  productKey: string | null;
  notes: string | null;
  taxName1: string | null;
  taxRate1: string | null;
}

/**
 * Provider payload retained for provenance (ADR-0009 #3). Does not carry the
 * client's own PII (that lives on the client fact), but does carry Loxep's
 * own line descriptions verbatim.
 */
export type InvoiceNinjaRawInvoicePayload = Readonly<Record<string, unknown>>;

export interface InvoiceNinjaInvoiceFact {
  externalInvoiceId: string;
  externalClientId: string | null;
  /** '' until Ninja assigns one (see module doc) → mapped to null. */
  number: string | null;
  status: InvoiceNinjaInvoiceStatus;
  /** Invoice Ninja's own status_id, verbatim, as the STRING it arrives as. */
  statusIdRaw: string;
  /** False only if statusIdRaw fell outside the known 1..6 set (defensive; not expected). */
  statusRecognized: boolean;
  /** DECIMAL string. */
  amount: string;
  /** DECIMAL string — the design's `external_balance_amount`. */
  balance: string;
  /** DECIMAL string. */
  paidToDate: string;
  /** 'YYYY-MM-DD' or null. */
  issueOn: string | null;
  /** 'YYYY-MM-DD' or null. */
  dueOn: string | null;
  poNumber: string | null;
  isDeleted: boolean;
  updatedAt: string | null;
  /** The client-facing portal link — '' until Ninja generates one. */
  portalUrl: string | null;
  lineItems: InvoiceNinjaLineItemFact[];
  /** MAY CONTAIN Loxep's own submitted line descriptions. */
  raw: InvoiceNinjaRawInvoicePayload;
}

function mapLineItem(raw: Record<string, unknown>): InvoiceNinjaLineItemFact {
  return {
    quantity: decimalFromUnknown(raw["quantity"]) ?? "1",
    cost: decimalFromUnknown(raw["cost"]) ?? ZERO,
    productKey: asText(raw["product_key"]),
    notes: asText(raw["notes"]),
    taxName1: asText(raw["tax_name1"]),
    taxRate1: decimalFromUnknown(raw["tax_rate1"]),
  };
}

function extractPortalUrl(raw: Record<string, unknown>): string | null {
  const invitations = asRecordArray(raw["invitations"]);
  const first = invitations[0];
  return first === undefined ? null : asText(first["link"]);
}

/** Pure mapping from a raw Invoice Ninja invoice payload to the Loxep-owned fact. */
export function mapInvoiceNinjaInvoice(
  raw: Record<string, unknown>,
): InvoiceNinjaInvoiceFact {
  const externalInvoiceId = asText(raw["id"]);
  if (externalInvoiceId === null) {
    throw new InvoiceNinjaAdapterError(
      "provider_unavailable",
      "Invoice Ninja invoice payload has no id; refusing to build an invoice fact",
    );
  }

  const statusIdRaw = asText(raw["status_id"]) ?? "1";
  const statusRecognized = isNativeInvoiceStatus(statusIdRaw);
  const status = statusRecognized
    ? INVOICENINJA_INVOICE_STATUS_MAP[statusIdRaw]
    : "draft";

  return {
    externalInvoiceId,
    externalClientId: asText(raw["client_id"]),
    number: asText(raw["number"]),
    status,
    statusIdRaw,
    statusRecognized,
    amount: decimalFromUnknown(raw["amount"]) ?? ZERO,
    balance: decimalFromUnknown(raw["balance"]) ?? ZERO,
    paidToDate: decimalFromUnknown(raw["paid_to_date"]) ?? ZERO,
    issueOn: asText(raw["date"]),
    dueOn: asText(raw["due_date"]),
    poNumber: asText(raw["po_number"]),
    isDeleted: raw["is_deleted"] === true,
    updatedAt: isoFromInvoiceNinjaTimestamp(raw["updated_at"]),
    portalUrl: extractPortalUrl(raw),
    lineItems: asRecordArray(raw["line_items"]).map(mapLineItem),
    raw,
  };
}

/**
 * Everything about an invoice fact EXCEPT `raw`. Use this for logging,
 * health surfaces, and any test output that could be printed.
 */
export function redactInvoiceNinjaInvoiceFact(
  fact: InvoiceNinjaInvoiceFact,
): Omit<InvoiceNinjaInvoiceFact, "raw"> & { raw: "[redacted]" } {
  const { raw: _raw, ...rest } = fact;
  return { ...rest, raw: "[redacted]" };
}

export interface InvoiceNinjaCreateLineItemInput {
  /** Decimal string — see money.ts. */
  quantity: string;
  /** Decimal string — the unit price. */
  cost: string;
  notes?: string;
  productKey?: string;
  taxName1?: string;
  /** Decimal string (percentage points, e.g. "8.25"). */
  taxRate1?: string;
}

/**
 * The push-side payload for a Loxep-billed invoice draft. `client_id` must
 * already be an Invoice Ninja client id (create/resolve the client
 * projection first — see `clients.ts`). `number` is deliberately never
 * accepted here — see the module doc's numbering-source discussion.
 */
export interface InvoiceNinjaCreateInvoiceInput {
  externalClientId: string;
  /** 'YYYY-MM-DD'. */
  issueOn?: string;
  /** 'YYYY-MM-DD'. */
  dueOn?: string;
  /** Loxep's own project/order reference, surfaced to Ninja as its po_number. */
  poNumber?: string;
  lineItems: InvoiceNinjaCreateLineItemInput[];
}

export function buildInvoiceNinjaInvoicePayload(
  input: InvoiceNinjaCreateInvoiceInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    client_id: input.externalClientId,
    line_items: input.lineItems.map((line) => {
      const item: Record<string, unknown> = {
        quantity: numberFromDecimal(line.quantity),
        cost: numberFromDecimal(line.cost),
      };
      if (line.notes !== undefined) item["notes"] = line.notes;
      if (line.productKey !== undefined) item["product_key"] = line.productKey;
      if (line.taxName1 !== undefined) item["tax_name1"] = line.taxName1;
      if (line.taxRate1 !== undefined) {
        item["tax_rate1"] = numberFromDecimal(line.taxRate1);
      }
      return item;
    }),
  };
  if (input.issueOn !== undefined) payload["date"] = input.issueOn;
  if (input.dueOn !== undefined) payload["due_date"] = input.dueOn;
  if (input.poNumber !== undefined) payload["po_number"] = input.poNumber;
  return payload;
}

export interface FetchInvoiceNinjaInvoicesInput {
  /** 1-based. Default 1. */
  page?: number;
  /** Default {@link INVOICENINJA_DEFAULT_PER_PAGE}. */
  perPage?: number;
}

export interface InvoiceNinjaInvoicePage {
  invoices: InvoiceNinjaInvoiceFact[];
  page: {
    total: number | null;
    currentPage: number;
    hasNextPage: boolean;
  };
}

function buildQuery(input: FetchInvoiceNinjaInvoicesInput): InvoiceNinjaQuery {
  const query: Record<string, number> = {};
  if (input.page !== undefined) query["page"] = input.page;
  if (input.perPage !== undefined) query["per_page"] = input.perPage;
  return query;
}

/** One page of invoices. */
export async function fetchInvoicesPage(
  adapter: InvoiceNinjaAdapter,
  input: FetchInvoiceNinjaInvoicesInput = {},
): Promise<InvoiceNinjaInvoicePage> {
  const result = await adapter.list("/invoices", buildQuery(input), {
    operation: "invoices.list",
  });
  return {
    invoices: result.items.map(mapInvoiceNinjaInvoice),
    page: {
      total: result.page.total,
      currentPage: result.page.currentPage,
      hasNextPage: result.page.hasNextPage,
    },
  };
}

/** Fetch a single invoice by its Invoice Ninja id. */
export async function fetchInvoice(
  adapter: InvoiceNinjaAdapter,
  externalInvoiceId: string,
): Promise<InvoiceNinjaInvoiceFact> {
  const response = await adapter.get(`/invoices/${externalInvoiceId}`, undefined, {
    operation: "invoices.get",
  });
  return mapInvoiceNinjaInvoice(response.data);
}

/**
 * Create a draft invoice from a Loxep-billed invoice. `number`/`portalUrl`
 * are expected to still be empty on the immediate response — Invoice
 * Ninja's counter-based numbering (`GeneratesCounter`, source above) and
 * invitation-link generation are believed to run around the send/email
 * step rather than at draft creation, but this specific sequencing was NOT
 * authenticated-live-confirmed for Invoice Ninja; callers should re-fetch
 * after {@link markInvoiceSent} rather than
 * assume either field is populated immediately after `createInvoice`.
 */
export async function createInvoice(
  adapter: InvoiceNinjaAdapter,
  input: InvoiceNinjaCreateInvoiceInput,
): Promise<InvoiceNinjaInvoiceFact> {
  const response = await adapter.post(
    "/invoices",
    buildInvoiceNinjaInvoicePayload(input),
    { operation: "invoices.create" },
  );
  return mapInvoiceNinjaInvoice(response.data);
}

/** Update a still-draft invoice (rejected by Invoice Ninja once issued/sent — see errors.ts). */
export async function updateInvoice(
  adapter: InvoiceNinjaAdapter,
  externalInvoiceId: string,
  input: InvoiceNinjaCreateInvoiceInput,
): Promise<InvoiceNinjaInvoiceFact> {
  const response = await adapter.put(
    `/invoices/${externalInvoiceId}`,
    buildInvoiceNinjaInvoicePayload(input),
    { operation: "invoices.update" },
  );
  return mapInvoiceNinjaInvoice(response.data);
}

/**
 * The design's "push happens at approved → issued" transition. Calls the
 * `GET /api/v1/invoices/{id}/mark_sent` action route
 * (`InvoiceController::performAction()`, source-verified — see module doc),
 * which flips `status_id` from draft to sent and is expected to assign the
 * customer-visible `number` and generate the client-portal invitation link
 * as a side effect (Invoice Ninja's own numbering-on-send behavior per
 * `GeneratesCounter`) — NOT independently live-confirmed here.
 */
export async function markInvoiceSent(
  adapter: InvoiceNinjaAdapter,
  externalInvoiceId: string,
): Promise<InvoiceNinjaInvoiceFact> {
  const response = await adapter.get(
    `/invoices/${externalInvoiceId}/mark_sent`,
    undefined,
    { operation: "invoices.mark_sent" },
  );
  return mapInvoiceNinjaInvoice(response.data);
}
