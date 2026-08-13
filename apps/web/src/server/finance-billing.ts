/**
 * On-demand Invoice Ninja draft-invoice push (loxep-v5r.5) — the composition
 * layer for `finance-billing-functions.ts`'s `pushDraftInvoice` server
 * function.
 *
 * ## Design-first honesty: what this module can and cannot do TODAY
 *
 * The Services & Billing Schema Design
 * (`apps/docs/src/content/docs/architecture/services-billing-schema-design.md`,
 * "Owner answers") says Loxep owns the source facts/billed-status/amounts,
 * Invoice Ninja owns rendering/delivery/numbering
 * (`numbering_source = 'ninja'`), and the linkage between the two is carried
 * by `external_resources`/`resource_links` — never a `ninja_client_id`
 * column bolted onto `counterparties`. This module implements that shape.
 *
 * This module deliberately does NOT import `@loxep/integration-invoiceninja`
 * (the adapter that actually talks to a Ninja instance) or `@loxep/work` (the
 * unbilled-work read model), even though `apps/web/package.json` now declares
 * both — `finance-billing-functions.ts` is where the real wiring lives.
 * (Earlier in this issue, neither package was declared at all: `bun -e
 * "import('@loxep/work')"` and the same for `@loxep/integration-invoiceninja`
 * failed to resolve from `apps/web`, so this module's pure/injected-deps
 * shape started as a hard requirement, not a preference — see git history /
 * the schema design doc's implementation record for that state.) The shape
 * is kept anyway because it is still the right one: `pushDraftInvoice`'s own
 * signature — `{ counterpartyId, projectId?, connectionId, lines }` — takes
 * line items as EXPLICIT input rather than this module reading them itself
 * from `@loxep/work`, and the only capability this module needs from "the
 * outside world" is "talk to one Invoice Ninja instance", injected as
 * {@link DraftInvoicePushDeps}. That keeps the composition logic fully unit
 * testable with stub deps (see `finance-billing.test.ts`) and free of any
 * direct dependency on the adapter's own boundary/error/rate-limit handling,
 * which stays exactly where `@loxep/integration-invoiceninja`'s module doc
 * says it belongs.
 *
 * ## The idempotency guard, and its honest limit
 *
 * "Has this already been pushed" is answered by the PRESENCE of a
 * `resource_links` row (`provider='invoiceninja'`, `purpose=
 * 'billing_invoice_draft'`), never a boolean flag — the design's own
 * "double-billing structurally impossible" posture, made possible today by
 * `resource_links`'s `unique(external_resource_id, resource_type,
 * resource_id, purpose)` constraint (migration `0004_link_table_
 * constraints.sql` — already shipped, so the dependency `loxep-v5r.5`'s own
 * description flagged as missing is in fact satisfied).
 *
 * The guard this module and its caller implement is coarser than the
 * design's eventual one: it is scoped to "this project" (or "this
 * counterparty" when no project is given), not to the exact set of source
 * facts (`time_entry`/`project_material_use` rows) a line was built from,
 * because `invoice_line_sources` — the table that would let a per-fact
 * anti-join exist — is design-only (`invoices`/`invoice_lines`/
 * `invoice_line_sources` are not built; see `@loxep/work`'s `unbilled.ts`
 * module doc for the identical admission on the read side). Concretely: once
 * a draft has been pushed for a project, a second push attempt for that same
 * project is refused even if new unbilled work has since accrued. That is a
 * real, honest limitation, not a bug — the alternative (silently allowing a
 * second draft) is the exact double-billing hazard the design calls out.
 */

export const INVOICENINJA_PROVIDER = 'invoiceninja';

/** `resource_links.purpose` for the counterparty → Ninja-client projection, matching `clients.ts`'s own documented vocabulary. */
export const BILLING_CLIENT_PURPOSE = 'billing_client';

/**
 * `resource_links.purpose` for THIS milestone's linkage.
 *
 * Deliberately NOT the design's eventual `purpose = 'delivery_document'` /
 * `resource_type = 'invoice'` — that pairing means "linked to a Loxep
 * `invoices` row that has been marked sent", and no `invoices` table exists
 * yet. Reusing that purpose now would make a future reader unable to tell a
 * real issued-invoice link from a draft-only push once the real table
 * lands. `resource_type` here is `'project'` (when a project was given) or
 * `'counterparty'` (an ad hoc push with no project) — never `'invoice'`.
 */
export const BILLING_DRAFT_PUSH_PURPOSE = 'billing_invoice_draft';

const DECIMAL_STRING = /^\d+(\.\d{1,6})?$/;

export class DraftInvoicePushValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftInvoicePushValidationError';
  }
}

/**
 * Thrown when the composition would need to reach a capability that
 * `apps/web/package.json` does not currently declare a dependency for. Never
 * thrown by pure logic in this module — only by the wiring in
 * `finance-billing-functions.ts` — but defined here so both the server
 * function and its tests can reference one error shape.
 */
export class FinanceBillingDependencyError extends Error {
  readonly missingPackages: readonly string[];

  constructor(missingPackages: readonly string[], detail: string) {
    super(
      `Invoice Ninja draft push is not wired: apps/web/package.json does not declare ${missingPackages.join(', ')}. ${detail}`
    );
    this.name = 'FinanceBillingDependencyError';
    this.missingPackages = missingPackages;
  }
}

export interface DraftInvoiceLineInput {
  description: string;
  /** Decimal string, e.g. "2.5". */
  quantity: string;
  /** Decimal string — the unit price, Ninja's own "cost". */
  unitCost: string;
}

/** The `resource_type`/`resource_id` a linkage row attaches to: a project when one was given, otherwise the counterparty itself. */
export function resolveBillingLinkTarget(input: {
  counterpartyId: string;
  projectId: string | null;
}): { resourceType: 'project' | 'counterparty'; resourceId: string } {
  return input.projectId !== null
    ? { resourceType: 'project', resourceId: input.projectId }
    : { resourceType: 'counterparty', resourceId: input.counterpartyId };
}

/** Throws {@link DraftInvoicePushValidationError} on the first invalid line; otherwise returns normally. */
export function validateDraftInvoiceLines(lines: DraftInvoiceLineInput[]): void {
  if (lines.length === 0) {
    throw new DraftInvoicePushValidationError(
      'at least one line item is required to push a draft invoice'
    );
  }
  for (const [index, line] of lines.entries()) {
    if (line.description.trim() === '') {
      throw new DraftInvoicePushValidationError(`line ${index + 1}: description is required`);
    }
    if (!DECIMAL_STRING.test(line.quantity)) {
      throw new DraftInvoicePushValidationError(
        `line ${index + 1}: quantity must be a positive decimal string, e.g. "2.5"`
      );
    }
    if (!DECIMAL_STRING.test(line.unitCost)) {
      throw new DraftInvoicePushValidationError(
        `line ${index + 1}: unitCost must be a positive decimal string, e.g. "125.00"`
      );
    }
  }
}

export interface EnsureNinjaClientResult {
  externalClientId: string;
  /** Loxep-facing URL recorded on the `external_resources` row (the Ninja instance's client admin URL when known). */
  url: string;
}

export interface CreateNinjaDraftInvoiceResult {
  externalInvoiceId: string;
  url: string;
  /** '' until Ninja assigns one — see `@loxep/integration-invoiceninja`'s `invoices.ts` — mapped to `null` here too. */
  number: string | null;
}

/**
 * The one capability this module needs injected: "talk to one Invoice Ninja
 * instance for one connection". A real implementation is
 * `@loxep/integration-invoiceninja` (`createInvoiceNinjaAdapter` +
 * `clients.ts`/`invoices.ts`) plus the DB-backed existing-client lookup —
 * see `finance-billing-functions.ts`.
 */
export interface DraftInvoicePushDeps {
  ensureNinjaClient: (input: {
    counterpartyId: string;
    displayName: string;
  }) => Promise<EnsureNinjaClientResult>;
  createDraftInvoiceOnNinja: (input: {
    externalClientId: string;
    /** Loxep's own project reference code (or counterparty reference code with no project), surfaced to Ninja as `po_number`. */
    poNumber: string | null;
    lines: DraftInvoiceLineInput[];
  }) => Promise<CreateNinjaDraftInvoiceResult>;
}

export interface ComposeDraftInvoicePushInput {
  counterpartyId: string;
  counterpartyDisplayName: string;
  counterpartyReferenceCode: string;
  projectId: string | null;
  projectReferenceCode: string | null;
  lines: DraftInvoiceLineInput[];
}

export interface DraftInvoicePushResult {
  client: EnsureNinjaClientResult;
  invoice: CreateNinjaDraftInvoiceResult;
}

/**
 * Pure orchestration: validate, ensure the Ninja client projection exists,
 * push the draft. Does not touch `resource_links`/`external_resources`
 * itself — the caller persists the linkage rows this function's result
 * implies, using {@link buildNinjaClientLinkage} / {@link
 * buildDraftInvoiceLinkage}, and is responsible for the idempotency check
 * BEFORE calling this (this function always creates, never checks).
 */
export async function composeDraftInvoicePush(
  input: ComposeDraftInvoicePushInput,
  deps: DraftInvoicePushDeps
): Promise<DraftInvoicePushResult> {
  validateDraftInvoiceLines(input.lines);

  const client = await deps.ensureNinjaClient({
    counterpartyId: input.counterpartyId,
    displayName: input.counterpartyDisplayName
  });

  const invoice = await deps.createDraftInvoiceOnNinja({
    externalClientId: client.externalClientId,
    poNumber: input.projectReferenceCode ?? input.counterpartyReferenceCode,
    lines: input.lines
  });

  return { client, invoice };
}

export interface ExternalResourceInsertValues {
  provider: string;
  connectionId: string;
  externalType: string;
  externalId: string;
  url: string;
  title: string | null;
}

export interface ResourceLinkInsertValues {
  resourceType: string;
  resourceId: string;
  purpose: string;
}

export interface LinkageRows {
  resource: ExternalResourceInsertValues;
  link: ResourceLinkInsertValues;
}

/** `resource_type='counterparty' purpose='billing_client'` — matches `@loxep/integration-invoiceninja`'s `clients.ts` module doc exactly. */
export function buildNinjaClientLinkage(input: {
  connectionId: string;
  counterpartyId: string;
  externalClientId: string;
  url: string;
  displayName: string;
}): LinkageRows {
  return {
    resource: {
      provider: INVOICENINJA_PROVIDER,
      connectionId: input.connectionId,
      externalType: 'client',
      externalId: input.externalClientId,
      url: input.url,
      title: input.displayName
    },
    link: {
      resourceType: 'counterparty',
      resourceId: input.counterpartyId,
      purpose: BILLING_CLIENT_PURPOSE
    }
  };
}

/** `purpose='billing_invoice_draft'` on the project (or counterparty) — see this module's doc for why NOT `resource_type='invoice'`. */
export function buildDraftInvoiceLinkage(input: {
  connectionId: string;
  counterpartyId: string;
  projectId: string | null;
  externalInvoiceId: string;
  url: string;
  number: string | null;
}): LinkageRows {
  const target = resolveBillingLinkTarget(input);
  return {
    resource: {
      provider: INVOICENINJA_PROVIDER,
      connectionId: input.connectionId,
      externalType: 'invoice_draft',
      externalId: input.externalInvoiceId,
      url: input.url,
      title: input.number ?? '(draft — unnumbered)'
    },
    link: {
      resourceType: target.resourceType,
      resourceId: target.resourceId,
      purpose: BILLING_DRAFT_PUSH_PURPOSE
    }
  };
}
