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
 * This module is SOURCE- AND FIXTURE-VERIFIED. Authenticated live
 * verification remains pending and requires explicit live-test opt-in.
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
 * internal numeric currency-table id, not an ISO 4217 code. `currencyId` on
 * the READ side ({@link InvoiceNinjaClientFact}) is still carried through
 * opaquely (as the raw wire value) rather than guessed at, since resolving
 * it back to an ISO code would need the inverse of `id-maps.ts`'s table and
 * this package has no reader for it yet. The PUSH side (loxep-cd3.1) is
 * different: `id-maps.ts` ships a source-verified ISO-4217 -> Ninja
 * `currency_id` map (and the equivalent for `country_id`), and
 * {@link buildInvoiceNinjaClientPayload} sets `settings.currency_id` /
 * `country_id` when the caller supplies an ISO code this package can map —
 * see that function's own doc.
 */
import type { InvoiceNinjaAdapter, InvoiceNinjaQuery } from "./adapter.ts";
import { InvoiceNinjaAdapterError } from "./errors.ts";
import {
  ninjaCountryIdForAlpha2,
  ninjaCurrencyIdForIso4217,
} from "./id-maps.ts";
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
 * projection of one of its own `counterparties` rows.
 *
 * Widened (loxep-cd3.1) per `expense-entry-design.md` section 2's mapping
 * table, from a `{name, id_number}`-only push to everything the counterparty
 * already stores: `vat_number` <- `tax_identifier`, `address*` <-
 * `counterparty_sites` (billing site), `country_id`/`settings.currency_id`
 * <- the static maps in `id-maps.ts`, `phone`/`website` <- `contact_channels`,
 * `settings.payment_terms` <- `payment_terms_days`, `contacts[]` <-
 * `counterparty_contacts` + their channels via {@link mapCounterpartyContactForPush}.
 * Every field is optional and omitted when the caller has nothing to send —
 * this stays "Loxep's counterparty is authoritative, the Ninja client is a
 * projection of it", just a fuller one.
 *
 * Field names SOURCE-VERIFIED against `app/Models/Client.php`'s `$fillable`
 * and `app/Http/Requests/Client/StoreClientRequest.php` (`invoiceninja/
 * invoiceninja`, `v5-stable`, commit `dcc27c94dc0c463341676a0c19b89d927c3d1287`,
 * fetched 2026-08-15) — see `id-maps.ts`'s module doc for the fuller citation
 * and the live-verification caveat.
 */
export interface InvoiceNinjaCreateClientInput {
  name: string;
  /** Maps to Ninja's own free-text `id_number` — not a currency/VAT id. */
  idNumber?: string;
  /** `counterparties.tax_identifier`. */
  vatNumber?: string;
  /** `contact_channels` where `channel_kind = 'website'`. */
  website?: string;
  /** `contact_channels` where `channel_kind in ('phone','mobile')`, `is_primary`. */
  phone?: string;
  /** `counterparty_sites` where `site_kind = 'billing'` (or the role's `billing_site_id`). */
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  /** ISO-3166-1 alpha-2; mapped via {@link ninjaCountryIdForAlpha2}, omitted when unmapped. */
  countryAlpha2?: string;
  /** ISO-4217 alpha code; mapped via {@link ninjaCurrencyIdForIso4217}, omitted when unmapped. */
  currencyCode?: string;
  /** `counterparty_entity_roles.payment_terms_days`. Sent as Ninja's own `settings.payment_terms` string. */
  paymentTermsDays?: number;
  /**
   * `counterparties.notes` — OPT-IN per push, per the design's own rule: an
   * operator's private note is not synced to a third-party system by
   * default. The CALLER decides whether to populate this field at all; this
   * builder does not default it off on its own (there is nothing to default
   * — omitting the field IS "off").
   */
  privateNotes?: string;
  /** `counterparty_contacts` + their primary email channel. */
  contacts?: InvoiceNinjaPushContactInput[];
}

/** One `contacts[]` entry of the push payload — see {@link mapCounterpartyContactForPush}. */
export interface InvoiceNinjaPushContactInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  isPrimary?: boolean;
}

/**
 * The one genuine schema gap the mapping table found: `counterparty_contacts`
 * carried only `display_name` before migration 0023.
 *
 * ADR-shape rule, stated in the design: *"the adapter sends the split names
 * when present and falls back to putting `display_name` in `first_name` when
 * absent, which is what every other integration does with a mononym."* A
 * blank/whitespace-only `givenName`/`familyName` counts as absent.
 */
export interface CounterpartyContactForPush {
  displayName: string;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
  isPrimary: boolean;
}

function nonBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function mapCounterpartyContactForPush(
  contact: CounterpartyContactForPush,
): InvoiceNinjaPushContactInput {
  const givenName = nonBlank(contact.givenName);
  const familyName = nonBlank(contact.familyName);
  const hasSplitName = givenName !== null || familyName !== null;
  const result: InvoiceNinjaPushContactInput = { isPrimary: contact.isPrimary };
  if (hasSplitName) {
    if (givenName !== null) result.firstName = givenName;
    if (familyName !== null) result.lastName = familyName;
  } else {
    result.firstName = contact.displayName;
  }
  const email = nonBlank(contact.email);
  if (email !== null) result.email = email;
  return result;
}

export function buildInvoiceNinjaClientPayload(
  input: InvoiceNinjaCreateClientInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: input.name };
  if (input.idNumber !== undefined) payload["id_number"] = input.idNumber;
  if (input.vatNumber !== undefined) payload["vat_number"] = input.vatNumber;
  if (input.website !== undefined) payload["website"] = input.website;
  if (input.phone !== undefined) payload["phone"] = input.phone;
  if (input.address1 !== undefined) payload["address1"] = input.address1;
  if (input.address2 !== undefined) payload["address2"] = input.address2;
  if (input.city !== undefined) payload["city"] = input.city;
  if (input.state !== undefined) payload["state"] = input.state;
  if (input.postalCode !== undefined) payload["postal_code"] = input.postalCode;
  if (input.privateNotes !== undefined) {
    payload["private_notes"] = input.privateNotes;
  }

  const countryId = ninjaCountryIdForAlpha2(input.countryAlpha2);
  // Client.php casts `country_id` to `string` — matched here rather than
  // sending a number, per the model's own $casts.
  if (countryId !== null) payload["country_id"] = String(countryId);

  const currencyId = ninjaCurrencyIdForIso4217(input.currencyCode);
  const settings: Record<string, unknown> = {};
  if (currencyId !== null) settings["currency_id"] = String(currencyId);
  if (input.paymentTermsDays !== undefined) {
    settings["payment_terms"] = String(input.paymentTermsDays);
  }
  if (Object.keys(settings).length > 0) payload["settings"] = settings;

  if (input.contacts !== undefined && input.contacts.length > 0) {
    payload["contacts"] = input.contacts.map((contact) => {
      const wire: Record<string, unknown> = {};
      if (contact.firstName !== undefined) wire["first_name"] = contact.firstName;
      if (contact.lastName !== undefined) wire["last_name"] = contact.lastName;
      if (contact.email !== undefined) wire["email"] = contact.email;
      if (contact.isPrimary !== undefined) wire["is_primary"] = contact.isPrimary;
      return wire;
    });
  }

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
