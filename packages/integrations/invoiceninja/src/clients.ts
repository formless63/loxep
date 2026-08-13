/**
 * Client read/write adapter: Invoice Ninja v5 `/api/v1/clients` normalized
 * to/from Loxep-owned facts, aligned to the Services & Billing Schema
 * Design's `external_resources` vocabulary
 * (`provider='invoiceninja' external_type='client' resource_type='counterparty'
 * purpose='billing_client'`) — Loxep's `counterparties` row is authoritative;
 * the Invoice Ninja client is a PROJECTION of it, pushed one-way.
 *
 * SOURCE-VERIFIED against `App\Transformers\ClientTransformer::transform()`
 * and `App\Transformers\ClientContactTransformer::transform()`
 * (`invoiceninja/invoiceninja`, `v5-stable` branch, fetched 2026-08-13).
 * NOT independently confirmed against the live instance on this host: no API
 * token was available in this environment (see `credentials.ts`), so this
 * module is FIXTURES/SOURCE-VERIFIED ONLY — live verification is the
 * follow-up bead's job.
 *
 * ## A field format Medusa/WooCommerce do not have: Unix-second timestamps
 *
 * `updated_at`/`created_at`/`archived_at` are cast `(int)` in the
 * transformer — a Unix epoch in SECONDS, not an ISO-8601 string the way
 * every other adapter in this codebase reports it, and NOT milliseconds.
 * {@link isoFromInvoiceNinjaTimestamp} converts it; a `0`/absent value (an
 * unset `deleted_at`, i.e. `archived_at`) maps to `null` rather than the
 * Unix epoch instant, since Invoice Ninja never means "archived at
 * 1970-01-01" by that.
 *
 * ## Field sources
 *
 * ```text
 * externalClientId   ← id                  hashids-encoded opaque string
 * name               ← name
 * displayName        ← display_name         presenter-computed; falls back to name
 * number             ← number               Ninja's own client number, may be ''
 * idNumber           ← id_number            business/tax id text, may be ''
 * balance            ← balance              DECIMAL — see money.ts
 * paidToDate         ← paid_to_date         DECIMAL
 * isDeleted          ← is_deleted
 * updatedAt          ← updated_at           Unix SECONDS — see above
 * contacts[].email    ← contacts[].email     default-included; '' when unset
 * ```
 *
 * `settings.currency_id` exists on the wire but is Invoice Ninja's OWN
 * internal numeric currency-table id, not an ISO 4217 code, and was not
 * resolved for this package (no confirmed mapping table). `currencyId` is
 * carried through opaquely (as the raw wire value) rather than guessed at,
 * and Loxep does not currently set it on push — Invoice Ninja defaults a new
 * client to the company's own default currency.
 */
import type { InvoiceNinjaAdapter, InvoiceNinjaQuery } from "./adapter.ts";
import { InvoiceNinjaAdapterError } from "./errors.ts";
import { decimalFromUnknown } from "./money.ts";

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

/**
 * Invoice Ninja's `(int) $model->updated_at` etc. — a Unix epoch in SECONDS.
 * `0`/absent maps to `null` (Invoice Ninja's convention for "not set", most
 * visibly on `archived_at` for a client that was never archived).
 */
export function isoFromInvoiceNinjaTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

const ZERO = "0.00";

export interface InvoiceNinjaContactFact {
  externalContactId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  isPrimary: boolean;
}

/**
 * Provider payload retained for provenance (ADR-0009 #3). MAY CONTAIN
 * PERSONAL DATA — a client's own contacts carry names/emails/phone numbers.
 */
export type InvoiceNinjaRawClientPayload = Readonly<Record<string, unknown>>;

export interface InvoiceNinjaClientFact {
  externalClientId: string;
  name: string;
  displayName: string;
  number: string | null;
  idNumber: string | null;
  vatNumber: string | null;
  /** DECIMAL string — see money.ts. */
  balance: string;
  /** DECIMAL string. */
  paidToDate: string;
  isDeleted: boolean;
  updatedAt: string | null;
  contacts: InvoiceNinjaContactFact[];
  /** MAY CONTAIN PERSONAL DATA — see {@link InvoiceNinjaRawClientPayload}. */
  raw: InvoiceNinjaRawClientPayload;
}

function mapContact(raw: Record<string, unknown>): InvoiceNinjaContactFact {
  return {
    externalContactId: asText(raw["id"]) ?? "",
    firstName: asText(raw["first_name"]),
    lastName: asText(raw["last_name"]),
    email: asText(raw["email"]),
    isPrimary: raw["is_primary"] === true,
  };
}

/** Pure mapping from a raw Invoice Ninja client payload to the Loxep-owned fact. */
export function mapInvoiceNinjaClient(
  raw: Record<string, unknown>,
): InvoiceNinjaClientFact {
  const externalClientId = asText(raw["id"]);
  if (externalClientId === null) {
    throw new InvoiceNinjaAdapterError(
      "provider_unavailable",
      "Invoice Ninja client payload has no id; refusing to build a client fact",
    );
  }
  return {
    externalClientId,
    name: asText(raw["name"]) ?? "",
    displayName: asText(raw["display_name"]) ?? asText(raw["name"]) ?? "",
    number: asText(raw["number"]),
    idNumber: asText(raw["id_number"]),
    vatNumber: asText(raw["vat_number"]),
    balance: decimalFromUnknown(raw["balance"]) ?? ZERO,
    paidToDate: decimalFromUnknown(raw["paid_to_date"]) ?? ZERO,
    isDeleted: raw["is_deleted"] === true,
    updatedAt: isoFromInvoiceNinjaTimestamp(raw["updated_at"]),
    contacts: asRecordArray(raw["contacts"]).map(mapContact),
    raw,
  };
}

/**
 * Everything about a client fact EXCEPT `raw` (and its contacts' PII). Use
 * this for logging, health surfaces, and any test output that could be
 * printed.
 */
export function redactInvoiceNinjaClientFact(
  fact: InvoiceNinjaClientFact,
): Omit<InvoiceNinjaClientFact, "raw" | "contacts"> & {
  raw: "[redacted]";
  contactCount: number;
} {
  const { raw: _raw, contacts, ...rest } = fact;
  return { ...rest, raw: "[redacted]", contactCount: contacts.length };
}

/**
 * The push-side payload — the fields Loxep sets when creating/updating a
 * projection of one of its own `counterparties` rows. Deliberately minimal:
 * `name` is the only field this package currently pushes, matching the
 * design's "Loxep's counterparty is authoritative, the Ninja client is a
 * projection of it" rule without inventing a mapping for fields (address,
 * tax settings, currency) this package has not verified a use for yet.
 */
export interface InvoiceNinjaCreateClientInput {
  name: string;
  /** Maps to Ninja's own free-text `id_number` — not a currency/VAT id. */
  idNumber?: string;
}

export function buildInvoiceNinjaClientPayload(
  input: InvoiceNinjaCreateClientInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: input.name };
  if (input.idNumber !== undefined) payload["id_number"] = input.idNumber;
  return payload;
}

export interface FetchInvoiceNinjaClientsInput {
  /** 1-based. Default 1. */
  page?: number;
  /** Default {@link INVOICENINJA_DEFAULT_PER_PAGE}. */
  perPage?: number;
}

export interface InvoiceNinjaClientPage {
  clients: InvoiceNinjaClientFact[];
  page: {
    total: number | null;
    currentPage: number;
    hasNextPage: boolean;
  };
}

function buildQuery(input: FetchInvoiceNinjaClientsInput): InvoiceNinjaQuery {
  const query: Record<string, number> = {};
  if (input.page !== undefined) query["page"] = input.page;
  if (input.perPage !== undefined) query["per_page"] = input.perPage;
  return query;
}

/** One page of clients. */
export async function fetchClientsPage(
  adapter: InvoiceNinjaAdapter,
  input: FetchInvoiceNinjaClientsInput = {},
): Promise<InvoiceNinjaClientPage> {
  const result = await adapter.list("/clients", buildQuery(input), {
    operation: "clients.list",
  });
  return {
    clients: result.items.map(mapInvoiceNinjaClient),
    page: {
      total: result.page.total,
      currentPage: result.page.currentPage,
      hasNextPage: result.page.hasNextPage,
    },
  };
}

/** Fetch a single client by its Invoice Ninja id. */
export async function fetchClient(
  adapter: InvoiceNinjaAdapter,
  externalClientId: string,
): Promise<InvoiceNinjaClientFact> {
  const response = await adapter.get(`/clients/${externalClientId}`, undefined, {
    operation: "clients.get",
  });
  return mapInvoiceNinjaClient(response.data);
}

/** Create a client projection of a Loxep counterparty. */
export async function createClient(
  adapter: InvoiceNinjaAdapter,
  input: InvoiceNinjaCreateClientInput,
): Promise<InvoiceNinjaClientFact> {
  const response = await adapter.post(
    "/clients",
    buildInvoiceNinjaClientPayload(input),
    { operation: "clients.create" },
  );
  return mapInvoiceNinjaClient(response.data);
}

/** Update an existing client projection. */
export async function updateClient(
  adapter: InvoiceNinjaAdapter,
  externalClientId: string,
  input: InvoiceNinjaCreateClientInput,
): Promise<InvoiceNinjaClientFact> {
  const response = await adapter.put(
    `/clients/${externalClientId}`,
    buildInvoiceNinjaClientPayload(input),
    { operation: "clients.update" },
  );
  return mapInvoiceNinjaClient(response.data);
}
