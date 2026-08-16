import { describe, expect, test } from 'bun:test';
import {
  invoiceNinjaClientCrossReference,
  invoiceNinjaInvoiceCrossReference
} from './invoiceninja-estate-functions.ts';

describe('invoiceNinjaClientCrossReference (loxep-47o.8)', () => {
  test('unlinked when no external_resources row exists for this client', () => {
    const result = invoiceNinjaClientCrossReference(undefined, new Map(), new Map());
    expect(result).toEqual({ kind: 'unlinked' });
  });

  test('unlinked when a resource row exists but no billing_client resource_links row attaches it', () => {
    const result = invoiceNinjaClientCrossReference({ id: 'resource-1' }, new Map(), new Map());
    expect(result).toEqual({ kind: 'unlinked' });
  });

  test('unlinked when the link points at a counterparty that no longer resolves', () => {
    const counterpartyIdByExternalResourceId = new Map([['resource-1', 'counterparty-1']]);
    const result = invoiceNinjaClientCrossReference(
      { id: 'resource-1' },
      counterpartyIdByExternalResourceId,
      new Map()
    );
    expect(result).toEqual({ kind: 'unlinked' });
  });

  test('linked when the resource is attached to a counterparty that resolves', () => {
    const counterpartyIdByExternalResourceId = new Map([['resource-1', 'counterparty-1']]);
    const counterpartyById = new Map([
      ['counterparty-1', { displayName: 'Acme Co', referenceCode: 'CP-2026-0001' }]
    ]);
    const result = invoiceNinjaClientCrossReference(
      { id: 'resource-1' },
      counterpartyIdByExternalResourceId,
      counterpartyById
    );
    expect(result).toEqual({
      kind: 'linked',
      counterpartyId: 'counterparty-1',
      counterpartyDisplayName: 'Acme Co',
      counterpartyReferenceCode: 'CP-2026-0001'
    });
  });
});

describe('invoiceNinjaInvoiceCrossReference (loxep-47o.8)', () => {
  test('unlinked when no external_resources row exists for this invoice', () => {
    const result = invoiceNinjaInvoiceCrossReference(undefined, new Map(), new Map(), new Map());
    expect(result).toEqual({ kind: 'unlinked' });
  });

  test('unlinked when a resource row exists but no billing_invoice_draft link attaches it', () => {
    const result = invoiceNinjaInvoiceCrossReference(
      { id: 'resource-1' },
      new Map(),
      new Map(),
      new Map()
    );
    expect(result).toEqual({ kind: 'unlinked' });
  });

  test('linked directly to a counterparty (ad hoc push, no project)', () => {
    const linkByExternalResourceId = new Map([
      ['resource-1', { resourceType: 'counterparty', resourceId: 'counterparty-1' }]
    ]);
    const counterpartyById = new Map([['counterparty-1', { displayName: 'Acme Co' }]]);
    const result = invoiceNinjaInvoiceCrossReference(
      { id: 'resource-1' },
      linkByExternalResourceId,
      counterpartyById,
      new Map()
    );
    expect(result).toEqual({
      kind: 'linked',
      counterpartyDisplayName: 'Acme Co',
      projectReferenceCode: null
    });
  });

  test('linked to a project, resolving the project counterparty and reference code', () => {
    const linkByExternalResourceId = new Map([
      ['resource-1', { resourceType: 'project', resourceId: 'project-1' }]
    ]);
    const counterpartyById = new Map([['counterparty-1', { displayName: 'Acme Co' }]]);
    const projectById = new Map([
      ['project-1', { referenceCode: 'PR-2026-0001', counterpartyId: 'counterparty-1' }]
    ]);
    const result = invoiceNinjaInvoiceCrossReference(
      { id: 'resource-1' },
      linkByExternalResourceId,
      counterpartyById,
      projectById
    );
    expect(result).toEqual({
      kind: 'linked',
      counterpartyDisplayName: 'Acme Co',
      projectReferenceCode: 'PR-2026-0001'
    });
  });

  test('linked to a project with no resolvable counterparty still names the project', () => {
    const linkByExternalResourceId = new Map([
      ['resource-1', { resourceType: 'project', resourceId: 'project-1' }]
    ]);
    const projectById = new Map([
      ['project-1', { referenceCode: 'PR-2026-0001', counterpartyId: null }]
    ]);
    const result = invoiceNinjaInvoiceCrossReference(
      { id: 'resource-1' },
      linkByExternalResourceId,
      new Map(),
      projectById
    );
    expect(result).toEqual({
      kind: 'linked',
      counterpartyDisplayName: null,
      projectReferenceCode: 'PR-2026-0001'
    });
  });
});
