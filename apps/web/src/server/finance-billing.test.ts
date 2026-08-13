/**
 * Unit tests for the pure composition/linkage logic in `finance-billing.ts`
 * (loxep-v5r.5). Run with Bun's built-in test runner (no vitest dependency
 * needed — apps/web has no vitest harness today, see this file's sibling
 * report): `bun test apps/web/src/server/finance-billing.test.ts`.
 *
 * The stub `DraftInvoicePushDeps` fakes below follow the same
 * fixture-stub-adapter pattern `packages/integrations/invoiceninja/test/`
 * uses for its own adapter tests — a fake object implementing the injected
 * interface, no network, no DB.
 */
import { describe, expect, test } from 'bun:test';
import {
  BILLING_CLIENT_PURPOSE,
  BILLING_DRAFT_PUSH_PURPOSE,
  INVOICENINJA_PROVIDER,
  DraftInvoicePushValidationError,
  buildDraftInvoiceLinkage,
  buildNinjaClientLinkage,
  composeDraftInvoicePush,
  resolveBillingLinkTarget,
  validateDraftInvoiceLines,
  type DraftInvoicePushDeps,
  type DraftInvoiceLineInput
} from './finance-billing.ts';

function line(overrides: Partial<DraftInvoiceLineInput> = {}): DraftInvoiceLineInput {
  return { description: 'Consulting hours', quantity: '2.5', unitCost: '125.00', ...overrides };
}

function fakeDeps(overrides: Partial<DraftInvoicePushDeps> = {}): DraftInvoicePushDeps {
  return {
    ensureNinjaClient: async ({ counterpartyId }) => ({
      externalClientId: `ninja-client-${counterpartyId}`,
      url: 'https://billing.example.com/clients/abc'
    }),
    createDraftInvoiceOnNinja: async () => ({
      externalInvoiceId: 'ninja-invoice-1',
      url: 'https://billing.example.com/invoices/1',
      number: null
    }),
    ...overrides
  };
}

describe('validateDraftInvoiceLines', () => {
  test('rejects an empty line list', () => {
    expect(() => validateDraftInvoiceLines([])).toThrow(DraftInvoicePushValidationError);
  });

  test('rejects a blank description', () => {
    expect(() => validateDraftInvoiceLines([line({ description: '  ' })])).toThrow(
      /description is required/
    );
  });

  for (const quantity of ['abc', '-1', '1.2345678', '']) {
    test(`rejects a malformed quantity ${JSON.stringify(quantity)}`, () => {
      expect(() => validateDraftInvoiceLines([line({ quantity })])).toThrow(/quantity/);
    });
  }

  for (const unitCost of ['abc', '-5.00', '']) {
    test(`rejects a malformed unitCost ${JSON.stringify(unitCost)}`, () => {
      expect(() => validateDraftInvoiceLines([line({ unitCost })])).toThrow(/unitCost/);
    });
  }

  test('accepts a well-formed line list and does not throw', () => {
    expect(() => validateDraftInvoiceLines([line(), line({ quantity: '1' })])).not.toThrow();
  });
});

describe('resolveBillingLinkTarget', () => {
  test('targets the project when one is given', () => {
    expect(resolveBillingLinkTarget({ counterpartyId: 'cp-1', projectId: 'proj-1' })).toEqual({
      resourceType: 'project',
      resourceId: 'proj-1'
    });
  });

  test('falls back to the counterparty when no project is given', () => {
    expect(resolveBillingLinkTarget({ counterpartyId: 'cp-1', projectId: null })).toEqual({
      resourceType: 'counterparty',
      resourceId: 'cp-1'
    });
  });
});

describe('composeDraftInvoicePush', () => {
  const baseInput = {
    counterpartyId: 'cp-1',
    counterpartyDisplayName: 'Acme Roofing',
    counterpartyReferenceCode: 'CP-2026-0001',
    projectId: null as string | null,
    projectReferenceCode: null as string | null,
    lines: [line()]
  };

  test('validates lines before ever calling a dep', async () => {
    let calls = 0;
    const deps = fakeDeps({
      ensureNinjaClient: async () => {
        calls += 1;
        return { externalClientId: 'x', url: 'https://x' };
      }
    });
    await expect(composeDraftInvoicePush({ ...baseInput, lines: [] }, deps)).rejects.toThrow(
      DraftInvoicePushValidationError
    );
    expect(calls).toBe(0);
  });

  test('ensures the client, then pushes the invoice with a project poNumber when a project is given', async () => {
    const poNumbers: (string | null)[] = [];
    const deps = fakeDeps({
      createDraftInvoiceOnNinja: async (input) => {
        poNumbers.push(input.poNumber);
        return { externalInvoiceId: 'inv-1', url: 'https://x/1', number: null };
      }
    });
    const result = await composeDraftInvoicePush(
      { ...baseInput, projectId: 'proj-1', projectReferenceCode: 'PRJ-2026-0042' },
      deps
    );
    expect(result.client.externalClientId).toBe('ninja-client-cp-1');
    expect(result.invoice.externalInvoiceId).toBe('inv-1');
    expect(poNumbers).toEqual(['PRJ-2026-0042']);
  });

  test('falls back to the counterparty reference code as poNumber when no project is given', async () => {
    const poNumbers: (string | null)[] = [];
    const deps = fakeDeps({
      createDraftInvoiceOnNinja: async (input) => {
        poNumbers.push(input.poNumber);
        return { externalInvoiceId: 'inv-2', url: 'https://x/2', number: null };
      }
    });
    await composeDraftInvoicePush(baseInput, deps);
    expect(poNumbers).toEqual(['CP-2026-0001']);
  });

  test('propagates a Ninja-side failure without partially recording anything (caller owns persistence)', async () => {
    const deps = fakeDeps({
      createDraftInvoiceOnNinja: async () => {
        throw new Error('provider_unavailable');
      }
    });
    await expect(composeDraftInvoicePush(baseInput, deps)).rejects.toThrow('provider_unavailable');
  });
});

describe('buildNinjaClientLinkage', () => {
  test("shapes an external_resources + resource_links row pair per the design's vocabulary", () => {
    const rows = buildNinjaClientLinkage({
      connectionId: 'conn-1',
      counterpartyId: 'cp-1',
      externalClientId: 'ninja-client-9',
      url: 'https://billing.example.com/clients/9',
      displayName: 'Acme Roofing'
    });
    expect(rows.resource).toEqual({
      provider: INVOICENINJA_PROVIDER,
      connectionId: 'conn-1',
      externalType: 'client',
      externalId: 'ninja-client-9',
      url: 'https://billing.example.com/clients/9',
      title: 'Acme Roofing'
    });
    expect(rows.link).toEqual({
      resourceType: 'counterparty',
      resourceId: 'cp-1',
      purpose: BILLING_CLIENT_PURPOSE
    });
  });
});

describe('buildDraftInvoiceLinkage', () => {
  test("links to the project, not 'invoice', when a project is given", () => {
    const rows = buildDraftInvoiceLinkage({
      connectionId: 'conn-1',
      counterpartyId: 'cp-1',
      projectId: 'proj-1',
      externalInvoiceId: 'inv-1',
      url: 'https://billing.example.com/invoices/1',
      number: null
    });
    expect(rows.link).toEqual({
      resourceType: 'project',
      resourceId: 'proj-1',
      purpose: BILLING_DRAFT_PUSH_PURPOSE
    });
    expect(rows.resource.externalType).toBe('invoice_draft');
    // Deliberately never 'invoice' — see this module's doc: that resource_type
    // is reserved for a real `invoices` table row, which does not exist yet.
    expect(rows.resource.externalType).not.toBe('invoice');
  });

  test('links to the counterparty when no project is given', () => {
    const rows = buildDraftInvoiceLinkage({
      connectionId: 'conn-1',
      counterpartyId: 'cp-1',
      projectId: null,
      externalInvoiceId: 'inv-2',
      url: 'https://billing.example.com/invoices/2',
      number: '0042'
    });
    expect(rows.link).toEqual({
      resourceType: 'counterparty',
      resourceId: 'cp-1',
      purpose: BILLING_DRAFT_PUSH_PURPOSE
    });
    expect(rows.resource.title).toBe('0042');
  });

  test('falls back to a placeholder title for a still-unnumbered draft', () => {
    const rows = buildDraftInvoiceLinkage({
      connectionId: 'conn-1',
      counterpartyId: 'cp-1',
      projectId: null,
      externalInvoiceId: 'inv-3',
      url: 'https://billing.example.com/invoices/3',
      number: null
    });
    expect(rows.resource.title).toBe('(draft — unnumbered)');
  });
});
