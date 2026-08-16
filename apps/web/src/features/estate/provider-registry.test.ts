import { describe, expect, test } from 'bun:test';
import {
  ESTATE_PROVIDER_REGISTRY,
  FINANCE_ESTATE_CATEGORY_PROVIDERS,
  INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS,
  estateHref,
  hasEstatePage
} from './provider-registry.ts';

describe('estate provider registry (loxep-47o.1, Rule P1/N1)', () => {
  test('pangolin and cloudflare are shipped estate pages under /infrastructure', () => {
    expect(hasEstatePage('pangolin')).toBe(true);
    expect(hasEstatePage('cloudflare')).toBe(true);
    expect(ESTATE_PROVIDER_REGISTRY.pangolin?.workspace).toBe('infrastructure');
    expect(ESTATE_PROVIDER_REGISTRY.cloudflare?.workspace).toBe('infrastructure');
  });

  test('a provider with no shipped estate page has no entry point', () => {
    expect(hasEstatePage('this-provider-does-not-exist')).toBe(false);
    expect(estateHref('this-provider-does-not-exist', 'connection-1')).toBeNull();
  });

  test('estateHref builds the P1 route shape — connection id is the only param, provider never in the path', () => {
    const link = estateHref('cloudflare', 'connection-1');
    expect(link).not.toBeNull();
    expect(link?.to).toBe('/infrastructure/estate/$connectionId');
    expect(link?.params).toEqual({ connectionId: 'connection-1' });
    // The provider name itself never appears in the built path.
    expect(link?.to.includes('cloudflare')).toBe(false);
  });

  test('every provider with a shipped estate page also has route params that resolve', () => {
    for (const provider of Object.keys(ESTATE_PROVIDER_REGISTRY)) {
      expect(estateHref(provider, 'connection-1')).not.toBeNull();
    }
  });

  test('the infrastructure-category set includes every shipped infrastructure provider', () => {
    for (const [provider, entry] of Object.entries(ESTATE_PROVIDER_REGISTRY)) {
      if (entry.workspace !== 'infrastructure') continue;
      expect(INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS.has(provider)).toBe(true);
    }
  });

  test('the infrastructure-category set excludes invoiceninja — that is a /finance estate', () => {
    expect(INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS.has('invoiceninja')).toBe(false);
  });

  test('invoiceninja is a shipped estate page under /finance (loxep-47o.8 — proves Rule P1)', () => {
    expect(hasEstatePage('invoiceninja')).toBe(true);
    expect(ESTATE_PROVIDER_REGISTRY.invoiceninja?.workspace).toBe('finance');
    const link = estateHref('invoiceninja', 'connection-1');
    expect(link).not.toBeNull();
    expect(link?.to).toBe('/finance/estate/$connectionId');
    expect(link?.params).toEqual({ connectionId: 'connection-1' });
  });

  test('the finance-category set contains invoiceninja and only providers whose registry workspace is finance', () => {
    expect(FINANCE_ESTATE_CATEGORY_PROVIDERS.has('invoiceninja')).toBe(true);
    for (const provider of FINANCE_ESTATE_CATEGORY_PROVIDERS) {
      expect(ESTATE_PROVIDER_REGISTRY[provider]?.workspace).toBe('finance');
    }
  });
});
