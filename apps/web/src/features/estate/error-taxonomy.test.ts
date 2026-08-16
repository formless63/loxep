import { describe, expect, test } from 'bun:test';
import { classifyCaughtProviderError, estateErrorSentence } from './error-taxonomy.ts';

class FakeAdapterError extends Error {
  readonly kind: string;
  readonly detail: Record<string, unknown>;
  constructor(kind: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

describe('classifyCaughtProviderError (loxep-47o.1, Rule P13)', () => {
  test('reads a known kind off the caught error, mirroring the ebay-oauth.ts precedent', () => {
    const info = classifyCaughtProviderError(new FakeAdapterError('auth', 'nope'), 'fallback');
    expect(info.kind).toBe('auth');
    expect(info.message).toBe('nope');
    expect(info.localRateBudget).toBe(false);
  });

  test('falls back to "unknown" for an unrecognized kind string', () => {
    const info = classifyCaughtProviderError(new FakeAdapterError('made_up', 'x'), 'fallback');
    expect(info.kind).toBe('unknown');
  });

  test('falls back to "unknown" for a plain Error with no kind', () => {
    const info = classifyCaughtProviderError(new Error('boom'), 'fallback');
    expect(info.kind).toBe('unknown');
    expect(info.message).toBe('boom');
  });

  test('falls back to "unknown" and the fallback message for a non-Error throw', () => {
    const info = classifyCaughtProviderError('a string was thrown', 'fallback message');
    expect(info.kind).toBe('unknown');
    expect(info.message).toBe('fallback message');
  });

  test('detects the local rate budget source distinctly from a provider 429', () => {
    const local = classifyCaughtProviderError(
      new FakeAdapterError('rate_limited', 'throttled', { source: 'local_rate_budget' }),
      'fallback'
    );
    expect(local.localRateBudget).toBe(true);

    const provider = classifyCaughtProviderError(
      new FakeAdapterError('rate_limited', 'provider said no', { source: 'provider' }),
      'fallback'
    );
    expect(provider.localRateBudget).toBe(false);
  });
});

describe('estateErrorSentence (Rule P13 — "the error kind\'s own sentence")', () => {
  test('the local-rate-budget sentence wins over the kind-specific one', () => {
    const sentence = estateErrorSentence({
      kind: 'rate_limited',
      message: 'x',
      localRateBudget: true
    });
    expect(sentence).toContain('Loxep throttled itself');
  });

  test('every known kind has a distinct sentence from every other kind', () => {
    const kinds = [
      'auth',
      'rate_limited',
      'not_found',
      'invalid_request',
      'provider_unavailable'
    ] as const;
    const sentences = kinds.map((kind) =>
      estateErrorSentence({ kind, message: 'x', localRateBudget: false })
    );
    expect(new Set(sentences).size).toBe(kinds.length);
  });

  test('an unknown kind still returns a non-empty sentence', () => {
    const sentence = estateErrorSentence({ kind: 'unknown', message: 'x', localRateBudget: false });
    expect(sentence.length).toBeGreaterThan(0);
  });
});
