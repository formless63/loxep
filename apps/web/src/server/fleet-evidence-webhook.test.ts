import { describe, expect, test } from 'bun:test';
import { admitFleetEvidenceWebhook, FleetEvidenceRateLimits } from './fleet-evidence-webhook.ts';

const NOW = new Date('2026-08-31T00:00:00.000Z');
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const DUMMY_CONNECTION_ID = '00000000-0000-0000-0000-000000000000';

function request(options: { token?: string; address?: string } = {}): Request {
  const headers = new Headers();
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  if (options.address !== undefined) headers.set('x-forwarded-for', options.address);
  return new Request(`http://loxep.test/api/v1/hooks/fleet/${CONNECTION_ID}`, {
    method: 'POST',
    headers
  });
}

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise<void>((settle) => {
      this.resolve = settle;
    });
  }
}

describe('FleetEvidenceRateLimits', () => {
  test('hard-bounds attacker-controlled attempt fingerprints without rejecting unrelated attempts', () => {
    const limits = new FleetEvidenceRateLimits({
      preAuthAttemptMaxRequests: 10_000,
      preAuthMaxTrackedAttempts: 3
    });

    for (let index = 0; index < 100; index += 1) {
      expect(limits.takePreAuth(CONNECTION_ID, `wrong-${index}`, NOW.getTime())).toBe(true);
      expect(limits.trackedPreAuthAttempts).toBeLessThanOrEqual(3);
    }
    expect(limits.trackedPreAuthAttempts).toBe(3);
  });

  test('an exhausted credential candidate does not reserve a denial window for another candidate', () => {
    const limits = new FleetEvidenceRateLimits({ preAuthAttemptMaxRequests: 1 });

    expect(limits.takePreAuth(CONNECTION_ID, 'wrong', NOW.getTime())).toBe(true);
    expect(limits.takePreAuth(CONNECTION_ID, 'wrong', NOW.getTime())).toBe(false);
    expect(limits.takePreAuth(CONNECTION_ID, 'legitimate', NOW.getTime())).toBe(true);
    expect(limits.takePreAuth(UNKNOWN_CONNECTION_ID, 'wrong', NOW.getTime())).toBe(true);
  });

  test('always releases a concurrent-verification slot when verifier work throws', async () => {
    const limits = new FleetEvidenceRateLimits({ maxConcurrentVerifications: 1 });

    await expect(
      limits.runVerification(async () => {
        throw new Error('verification failed');
      })
    ).rejects.toThrow('verification failed');
    expect(limits.concurrentVerifications).toBe(0);
    expect(await limits.runVerification(async () => 'recovered')).toEqual({
      admitted: true,
      value: 'recovered'
    });
  });
});

describe('admitFleetEvidenceWebhook', () => {
  test('does not treat untrusted forwarded headers as independent client identities', async () => {
    const limits = new FleetEvidenceRateLimits({ preAuthAttemptMaxRequests: 1 });
    let verificationCalls = 0;
    const verifyToken = async () => {
      verificationCalls += 1;
      return { ok: false as const };
    };

    const first = await admitFleetEvidenceWebhook({
      request: request({ token: 'wrong', address: '192.0.2.1' }),
      connectionId: UNKNOWN_CONNECTION_ID,
      now: NOW,
      limits,
      verifyToken
    });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.response.status).toBe(401);

    const rotatedHeader = await admitFleetEvidenceWebhook({
      request: request({ token: 'wrong', address: '198.51.100.99' }),
      connectionId: UNKNOWN_CONNECTION_ID,
      now: NOW,
      limits,
      verifyToken
    });
    expect(rotatedHeader.ok).toBe(false);
    if (!rotatedHeader.ok) expect(rotatedHeader.response.status).toBe(429);
    expect(verificationCalls).toBe(1);
  });

  test('normalizes a malformed UUID through verifier work and returns the uniform rejection', async () => {
    const limits = new FleetEvidenceRateLimits({ preAuthAttemptMaxRequests: 100 });
    const verifiedConnectionIds: string[] = [];
    const verifyToken = async ({ connectionId }: { connectionId: string }) => {
      verifiedConnectionIds.push(connectionId);
      return { ok: false as const };
    };

    const malformed = await admitFleetEvidenceWebhook({
      request: request({ token: 'wrong' }),
      connectionId: 'not-a-uuid',
      now: NOW,
      limits,
      verifyToken
    });
    const unknown = await admitFleetEvidenceWebhook({
      request: request({ token: 'wrong' }),
      connectionId: UNKNOWN_CONNECTION_ID,
      now: NOW,
      limits,
      verifyToken
    });

    expect(verifiedConnectionIds).toEqual([DUMMY_CONNECTION_ID, UNKNOWN_CONNECTION_ID]);
    if (malformed.ok || unknown.ok) throw new Error('expected both admissions to fail');
    expect(malformed.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    expect(await malformed.response.text()).toBe(await unknown.response.text());
    expect(malformed.response.headers.get('content-type')).toBe(
      unknown.response.headers.get('content-type')
    );
  });

  test('bad tokens do not consume the legitimate connection allowance', async () => {
    const limits = new FleetEvidenceRateLimits({
      preAuthAttemptMaxRequests: 2,
      postAuthConnectionMaxRequests: 2
    });
    const verifyToken = async ({ presentedToken }: { presentedToken: string }) =>
      presentedToken === 'good'
        ? { ok: true as const, connection: { id: CONNECTION_ID } }
        : { ok: false as const };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rejected = await admitFleetEvidenceWebhook({
        request: request({ token: 'wrong' }),
        connectionId: CONNECTION_ID,
        now: NOW,
        limits,
        verifyToken
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.response.status).toBe(401);
    }
    const repeatedBadToken = await admitFleetEvidenceWebhook({
      request: request({ token: 'wrong' }),
      connectionId: CONNECTION_ID,
      now: NOW,
      limits,
      verifyToken
    });
    if (!repeatedBadToken.ok) expect(repeatedBadToken.response.status).toBe(429);
    expect(limits.trackedPostAuthConnections).toBe(0);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const admitted = await admitFleetEvidenceWebhook({
        request: request({ token: 'good' }),
        connectionId: CONNECTION_ID,
        now: NOW,
        limits,
        verifyToken
      });
      expect(admitted.ok).toBe(true);
    }

    const exhausted = await admitFleetEvidenceWebhook({
      request: request({ token: 'good' }),
      connectionId: CONNECTION_ID,
      now: NOW,
      limits,
      verifyToken
    });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) {
      expect(exhausted.response.status).toBe(429);
      expect(await exhausted.response.json()).toEqual({ error: 'rate_limited' });
    }
  });

  test('sheds only while verifier concurrency is occupied, then immediately recovers', async () => {
    const limits = new FleetEvidenceRateLimits({
      preAuthAttemptMaxRequests: 100,
      maxConcurrentVerifications: 1
    });
    const heldVerification = new Deferred();
    const started = new Deferred();
    let verificationCalls = 0;

    const firstAdmission = admitFleetEvidenceWebhook({
      request: request({ token: 'first' }),
      connectionId: UNKNOWN_CONNECTION_ID,
      now: NOW,
      limits,
      verifyToken: async () => {
        verificationCalls += 1;
        started.resolve();
        await heldVerification.promise;
        return { ok: false as const };
      }
    });
    await started.promise;
    expect(limits.concurrentVerifications).toBe(1);

    const shed = await admitFleetEvidenceWebhook({
      request: request({ token: 'second' }),
      connectionId: UNKNOWN_CONNECTION_ID,
      now: NOW,
      limits,
      verifyToken: async () => {
        verificationCalls += 1;
        return { ok: false as const };
      }
    });
    if (!shed.ok) expect(shed.response.status).toBe(429);
    expect(verificationCalls).toBe(1);

    heldVerification.resolve();
    const first = await firstAdmission;
    if (!first.ok) expect(first.response.status).toBe(401);
    expect(limits.concurrentVerifications).toBe(0);

    const recovered = await admitFleetEvidenceWebhook({
      request: request({ token: 'third' }),
      connectionId: UNKNOWN_CONNECTION_ID,
      now: NOW,
      limits,
      verifyToken: async () => {
        verificationCalls += 1;
        return { ok: false as const };
      }
    });
    if (!recovered.ok) expect(recovered.response.status).toBe(401);
    expect(verificationCalls).toBe(2);
  });
});
