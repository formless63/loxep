import { describe, expect, test } from 'bun:test';
import { inferGatusEstatePosture, isGatusOidcDegradedRefusal } from './gatus-estate-functions.ts';

describe('inferGatusEstatePosture (loxep-47o.5)', () => {
  test('oidc wins regardless of a stored credential — the adapter’s own structural signal', () => {
    expect(inferGatusEstatePosture(true, false)).toBe('oidc');
    expect(inferGatusEstatePosture(true, true)).toBe('oidc');
  });

  test('basic when not oidc and a gatus_credentials bundle is stored', () => {
    expect(inferGatusEstatePosture(false, true)).toBe('basic');
  });

  test('open when not oidc and no credential is stored', () => {
    expect(inferGatusEstatePosture(false, false)).toBe('open');
  });
});

describe('isGatusOidcDegradedRefusal (loxep-47o.5)', () => {
  test('true for the adapter’s own structural OIDC refusal shape', () => {
    const error = {
      kind: 'auth',
      detail: { operation: 'endpoints.statuses', mode: 'oidc_degraded' }
    };
    expect(isGatusOidcDegradedRefusal(error)).toBe(true);
  });

  test('false for a genuine credential rejection in direct posture (no detail.mode)', () => {
    const error = { kind: 'auth', detail: { operation: 'endpoints.statuses', httpStatus: 401 } };
    expect(isGatusOidcDegradedRefusal(error)).toBe(false);
  });

  test('false for an error with no detail at all', () => {
    expect(isGatusOidcDegradedRefusal(new Error('boom'))).toBe(false);
  });

  test('false for a non-object detail', () => {
    expect(isGatusOidcDegradedRefusal({ detail: 'oops' })).toBe(false);
  });
});
