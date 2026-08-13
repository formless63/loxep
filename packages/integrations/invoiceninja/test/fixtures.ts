/**
 * Fixture payloads for the Invoice Ninja v5 REST API. Constructed from the
 * source-verified transformers (`invoiceninja/invoiceninja`, `v5-stable`
 * branch, fetched 2026-08-13) — see `src/clients.ts`/`src/invoices.ts` for
 * the field-by-field citation trail. No live authenticated response was
 * captured for this package (no write credential in this environment), so
 * these fixtures were never reconciled against a real payload the way the
 * Medusa adapter's were — flagged in the module docs as fixtures-only.
 *
 * ALL DATA HERE IS FAKE. No value in this file corresponds to any real
 * Invoice Ninja deployment.
 */

export interface FixtureOverrides {
  [key: string]: unknown;
}

/** The Fractal `ArraySerializer` single-item envelope. */
export function ninjaItemEnvelope(data: Record<string, unknown>): Record<string, unknown> {
  return { data };
}

/** The Fractal `ArraySerializer` paginated-collection envelope. */
export function ninjaListEnvelope(
  items: Array<Record<string, unknown>>,
  pagination: {
    total?: number;
    count?: number;
    perPage?: number;
    currentPage?: number;
    totalPages?: number;
    hasNext?: boolean;
  } = {},
): Record<string, unknown> {
  const links: Record<string, string> = {};
  if (pagination.currentPage !== undefined && pagination.currentPage > 1) {
    links["previous"] = "https://billing.example.invalid/api/v1/clients?page=1";
  }
  if (pagination.hasNext) {
    links["next"] = "https://billing.example.invalid/api/v1/clients?page=2";
  }
  return {
    data: items,
    meta: {
      pagination: {
        total: pagination.total ?? items.length,
        count: pagination.count ?? items.length,
        per_page: pagination.perPage ?? 20,
        current_page: pagination.currentPage ?? 1,
        total_pages: pagination.totalPages ?? 1,
        links,
      },
    },
  };
}

/** A minimal client, matching `ClientTransformer::transform()`'s field set. */
export function clientFixture(overrides: FixtureOverrides = {}): Record<string, unknown> {
  return {
    id: "FIXTURECLIENT01",
    user_id: "FIXTUREUSER01",
    assigned_user_id: "",
    name: "Fixture Roofing Co",
    website: "",
    private_notes: "",
    balance: 0,
    group_settings_id: "",
    paid_to_date: 1250.5,
    payment_balance: 0,
    credit_balance: 0,
    last_login: 0,
    size_id: "",
    public_notes: "",
    client_hash: "fixturehash01",
    address1: "",
    address2: "",
    phone: "",
    city: "",
    state: "",
    postal_code: "",
    country_id: "",
    industry_id: "",
    shipping_address1: "",
    shipping_address2: "",
    shipping_city: "",
    shipping_state: "",
    shipping_postal_code: "",
    shipping_country_id: "",
    settings: {},
    is_deleted: false,
    vat_number: "",
    id_number: "",
    updated_at: 1786598400,
    archived_at: 0,
    created_at: 1786512000,
    display_name: "Fixture Roofing Co",
    number: "",
    has_valid_vat_number: false,
    is_tax_exempt: false,
    routing_id: "",
    tax_info: {},
    classification: "",
    e_invoice: {},
    tags: [],
    contacts: [
      {
        id: "FIXTURECONTACT01",
        first_name: "Jamie",
        last_name: "Fixture",
        email: "jamie@fixture.invalid",
        created_at: 1786512000,
        updated_at: 1786512000,
        archived_at: 0,
        is_primary: true,
        is_locked: false,
        phone: "",
        custom_value1: "",
        custom_value2: "",
        custom_value3: "",
        custom_value4: "",
        contact_key: "fixturekey01",
        send_email: true,
        cc_only: false,
        last_login: 0,
        password: "",
        link: "https://billing.example.invalid/client/fixturekey01",
        can_sign: false,
      },
    ],
    documents: [],
    gateway_tokens: [],
    locations: [],
    ...overrides,
  };
}

/** A newly created client with no contacts and no balance history. */
export function newClientFixture(overrides: FixtureOverrides = {}): Record<string, unknown> {
  const base = clientFixture();
  return {
    ...base,
    id: "FIXTURECLIENT02",
    name: "Fixture New Co",
    display_name: "Fixture New Co",
    balance: 0,
    paid_to_date: 0,
    contacts: [],
    ...overrides,
  };
}

/** A draft invoice, matching `InvoiceTransformer::transform()`'s field set. */
export function draftInvoiceFixture(overrides: FixtureOverrides = {}): Record<string, unknown> {
  return {
    id: "FIXTUREINVOICE01",
    user_id: "FIXTUREUSER01",
    project_id: "",
    assigned_user_id: "",
    amount: 500,
    balance: 500,
    client_id: "FIXTURECLIENT01",
    vendor_id: "",
    status_id: "1",
    design_id: "",
    recurring_id: "",
    created_at: 1786512000,
    updated_at: 1786512000,
    archived_at: 0,
    is_deleted: false,
    number: "",
    discount: 0,
    po_number: "PROJ-FIXTURE-01",
    date: "2026-08-13",
    last_sent_date: "",
    next_send_date: "",
    due_date: "2026-09-12",
    terms: "",
    public_notes: "",
    private_notes: "",
    uses_inclusive_taxes: false,
    tax_name1: "",
    tax_rate1: 0,
    tax_name2: "",
    tax_rate2: 0,
    tax_name3: "",
    tax_rate3: 0,
    total_taxes: 0,
    is_amount_discount: false,
    footer: "",
    partial: 0,
    partial_due_date: "",
    custom_value1: "",
    custom_value2: "",
    custom_value3: "",
    custom_value4: "",
    has_tasks: false,
    has_expenses: false,
    custom_surcharge1: 0,
    custom_surcharge2: 0,
    custom_surcharge3: 0,
    custom_surcharge4: 0,
    exchange_rate: 1,
    custom_surcharge_tax1: false,
    custom_surcharge_tax2: false,
    custom_surcharge_tax3: false,
    custom_surcharge_tax4: false,
    line_items: [
      {
        quantity: 10,
        cost: 50,
        product_key: "",
        notes: "Consulting — March, 10 hours",
        discount: 0,
        is_amount_discount: false,
        tax_name1: "",
        tax_rate1: 0,
        line_total: 500,
      },
    ],
    entity_type: "invoice",
    reminder1_sent: "",
    reminder2_sent: "",
    reminder3_sent: "",
    reminder_last_sent: "",
    paid_to_date: 0,
    subscription_id: "",
    auto_bill_enabled: false,
    tax_info: {},
    e_invoice: {},
    backup: null,
    location_id: "",
    tags: [],
    sync: null,
    invitations: [
      {
        id: "FIXTUREINVITATION01",
        client_contact_id: "FIXTURECONTACT01",
        key: "fixtureinvitationkey01",
        link: "",
        sent_date: "",
        viewed_date: "",
        opened_date: "",
        updated_at: 1786512000,
        archived_at: 0,
        created_at: 1786512000,
        email_status: "",
        email_error: "",
        message_id: "",
        can_sign: false,
      },
    ],
    documents: [],
    ...overrides,
  };
}

/** A sent invoice — number assigned, invitation link populated, balance unpaid. */
export function sentInvoiceFixture(overrides: FixtureOverrides = {}): Record<string, unknown> {
  return draftInvoiceFixture({
    id: "FIXTUREINVOICE02",
    status_id: "2",
    number: "INV-0001",
    last_sent_date: "2026-08-13",
    invitations: [
      {
        id: "FIXTUREINVITATION02",
        client_contact_id: "FIXTURECONTACT01",
        key: "fixtureinvitationkey02",
        link: "https://billing.example.invalid/client/fixtureinvitationkey02/invoice",
        sent_date: "2026-08-13",
        viewed_date: "",
        opened_date: "",
        updated_at: 1786512000,
        archived_at: 0,
        created_at: 1786512000,
        email_status: "delivered",
        email_error: "",
        message_id: "fixture-message-01",
        can_sign: false,
      },
    ],
    ...overrides,
  });
}

/** A fully paid invoice. */
export function paidInvoiceFixture(overrides: FixtureOverrides = {}): Record<string, unknown> {
  return sentInvoiceFixture({
    id: "FIXTUREINVOICE03",
    status_id: "4",
    balance: 0,
    paid_to_date: 500,
    ...overrides,
  });
}

/** The Invoice Ninja error envelope for a token-auth failure. */
export function invalidTokenErrorBody(): Record<string, unknown> {
  return { message: "Invalid token" };
}

/** The Laravel validation-failure envelope for a 422. */
export function validationErrorBody(
  errors: Record<string, string[]>,
): Record<string, unknown> {
  return { message: "The given data was invalid.", errors };
}
