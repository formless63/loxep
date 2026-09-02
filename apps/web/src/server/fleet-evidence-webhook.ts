/**
 * Fleet alert evidence webhook handler (Phase 8 milestone 7, loxep-ovj.7) —
 * reached ONLY from `routes/api.v1.hooks.fleet.$connectionId.ts`'s `POST`
 * handler, via a dynamic import. Loxep's first inbound integration surface:
 * UNAUTHENTICATED BY SESSION, authenticated by a per-connection bearer token
 * alone (`@loxep/app`'s `verifyFleetIngestToken`).
 *
 * Order matters; admission deliberately separates unauthenticated abuse
 * defense from the verified connection's own blast-radius budget:
 *
 * 1. size-cap (`Content-Length` fast-reject, then a hard streamed cap — BOTH
 *    before any parsing)
 * 2. normalize malformed connection ids and rate-limit the credential-attempt
 *    fingerprint (in-memory — see below)
 * 3. load-shed excess concurrent verification work, then verify the token;
 *    every verifier rejection receives the same unauthorized response
 * 4. post-auth rate-limit (per verified connection)
 * 5. body read + `receiveFleetEvidence` (JSON parsing, provider dispatch,
 *    the `source_events` write, the transactional projection enqueue)
 *
 * The response NEVER echoes the payload back, at any step.
 *
 * ## In-memory rate limiting is a deliberate, documented trade-off
 *
 * The contract forbids Redis/Kafka/BullMQ (Graphile Worker on PostgreSQL is
 * the accepted job system) and a per-request DB write just to rate-limit
 * would add load to the one path that most needs to stay cheap under abuse.
 * Fixed-window counters held in process memory are therefore the honest MVP:
 * they reset on deploy and do not share state across `LOXEP_MODE=web`
 * replicas. Pre-auth attempts are keyed by a SHA-256 fingerprint of the
 * normalized connection id and presented token — never by spoofable forwarded
 * headers, and never by the target connection alone. Repeating one invalid
 * credential cannot reserve a denial window for another credential. A small
 * concurrent-verification ceiling sheds excess expensive work only while all
 * verifier slots are actually occupied; unlike a process-wide request quota,
 * it does not starve the whole fleet for the rest of a fixed window. Only a
 * successfully verified token spends the connection's own budget. Every
 * keyed map has a hard entry cap with O(1) oldest-entry eviction.
 */
import '@tanstack/react-start/server-only';

import { createHash } from 'node:crypto';
import { createTransactionalNotificationEnqueue } from '@loxep/domain';

const RATE_LIMIT_WINDOW_MS = 60_000;
const PRE_AUTH_ATTEMPT_MAX_REQUESTS_PER_WINDOW = 30;
const POST_AUTH_CONNECTION_MAX_REQUESTS_PER_WINDOW = 30;
const PRE_AUTH_MAX_TRACKED_ATTEMPTS = 2_048;
const POST_AUTH_MAX_TRACKED_CONNECTIONS = 5_000;
/** `pg` defaults to ten pooled clients; leave most of that pool to normal web traffic. */
const MAX_CONCURRENT_TOKEN_VERIFICATIONS = 4;

/** A valid UUID that normal connection creation never emits. */
const DUMMY_CONNECTION_ID = '00000000-0000-0000-0000-000000000000';
const CONNECTION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** `MAX_EVIDENCE_BODY_BYTES` — alert/backup-status JSON bodies are tiny; 64KB is generous headroom. */
const MAX_EVIDENCE_BODY_BYTES = 64 * 1024;

interface RateWindow {
  count: number;
  windowStart: number;
}

interface FixedWindowLimiterOptions {
  maxRequests: number;
  maxTrackedKeys: number;
  windowMs: number;
}

/**
 * A hard-bounded fixed-window limiter. `Map` preserves insertion order, so
 * deleting its first key is O(1) and needs no full-map expiry scan. Expiry is
 * checked lazily for the requested key.
 */
class FixedWindowLimiter {
  private readonly state = new Map<string, RateWindow>();

  constructor(private readonly options: FixedWindowLimiterOptions) {}

  take(key: string, now: number): boolean {
    const existing = this.state.get(key);
    if (existing !== undefined && now - existing.windowStart < this.options.windowMs) {
      existing.count = Math.min(existing.count + 1, this.options.maxRequests + 1);
      return existing.count <= this.options.maxRequests;
    }

    if (existing !== undefined) this.state.delete(key);
    if (this.state.size >= this.options.maxTrackedKeys) {
      const oldestKey = this.state.keys().next().value;
      if (oldestKey !== undefined) this.state.delete(oldestKey);
    }
    this.state.set(key, { count: 1, windowStart: now });
    return true;
  }

  /** Observable only so focused tests can prove the hard memory bound. */
  get trackedKeys(): number {
    return this.state.size;
  }
}

export interface FleetEvidenceRateLimitOptions {
  windowMs?: number;
  preAuthAttemptMaxRequests?: number;
  postAuthConnectionMaxRequests?: number;
  preAuthMaxTrackedAttempts?: number;
  postAuthMaxTrackedConnections?: number;
  maxConcurrentVerifications?: number;
}

/**
 * The admission controls used by the webhook. Exported so tests can
 * instantiate isolated, deliberately tiny budgets without mutating the
 * production singleton.
 */
export class FleetEvidenceRateLimits {
  private readonly attempts: FixedWindowLimiter;
  private readonly connections: FixedWindowLimiter;
  private readonly maxConcurrentVerifications: number;
  private activeVerifications = 0;

  constructor(options: FleetEvidenceRateLimitOptions = {}) {
    const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.attempts = new FixedWindowLimiter({
      maxRequests: options.preAuthAttemptMaxRequests ?? PRE_AUTH_ATTEMPT_MAX_REQUESTS_PER_WINDOW,
      maxTrackedKeys: options.preAuthMaxTrackedAttempts ?? PRE_AUTH_MAX_TRACKED_ATTEMPTS,
      windowMs
    });
    this.connections = new FixedWindowLimiter({
      maxRequests:
        options.postAuthConnectionMaxRequests ?? POST_AUTH_CONNECTION_MAX_REQUESTS_PER_WINDOW,
      maxTrackedKeys: options.postAuthMaxTrackedConnections ?? POST_AUTH_MAX_TRACKED_CONNECTIONS,
      windowMs
    });
    this.maxConcurrentVerifications =
      options.maxConcurrentVerifications ?? MAX_CONCURRENT_TOKEN_VERIFICATIONS;
  }

  /**
   * Rate-limit only this connection-id/token candidate. The digest prevents
   * plaintext bearer tokens from living in limiter state.
   */
  takePreAuth(connectionId: string, presentedToken: string, now: number): boolean {
    const fingerprint = createHash('sha256')
      .update(connectionId, 'utf8')
      .update('\0', 'utf8')
      .update(presentedToken, 'utf8')
      .digest('base64url');
    return this.attempts.take(fingerprint, now);
  }

  /**
   * Run verifier work only while a short-lived slot is available. There is no
   * queue and the slot is always released, including when verification throws.
   */
  async runVerification<T>(
    operation: () => Promise<T>
  ): Promise<{ admitted: true; value: T } | { admitted: false }> {
    if (this.activeVerifications >= this.maxConcurrentVerifications) {
      return { admitted: false };
    }

    this.activeVerifications += 1;
    try {
      return { admitted: true, value: await operation() };
    } finally {
      this.activeVerifications -= 1;
    }
  }

  /** Called only after token verification succeeds. */
  takePostAuth(connectionId: string, now: number): boolean {
    return this.connections.take(connectionId, now);
  }

  get trackedPreAuthAttempts(): number {
    return this.attempts.trackedKeys;
  }

  get trackedPostAuthConnections(): number {
    return this.connections.trackedKeys;
  }

  get concurrentVerifications(): number {
    return this.activeVerifications;
  }
}

/** Module-level, per-process state — see the module doc's rate-limiting note. */
const rateLimits = new FleetEvidenceRateLimits();

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * The uniform response every verifier rejection returns — an unknown
 * `connectionId`, a connection that is not an evidence-ingest one, a missing
 * `Authorization` header, and a wrong token all receive this status/body.
 * This is a response-semantics guarantee, not a wall-clock timing claim.
 */
function uniformUnauthorizedResponse(): Response {
  return jsonResponse(401, { error: 'unauthorized' });
}

/**
 * Read the request body up to `maxBytes`. Checks `Content-Length` first (a
 * cheap, header-only reject for an obviously oversized declared body), then
 * enforces the same cap while streaming — a sender that lies about or omits
 * `Content-Length` cannot bypass the limit.
 */
async function readBodyCapped(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) return { ok: false };
  }
  if (request.body === null) return { ok: true, text: '' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { ok: true, text: buffer.toString('utf8') };
}

function extractBearerToken(request: Request): string {
  const header = request.headers.get('authorization');
  if (header === null) return '';
  const match = /^Bearer (.+)$/u.exec(header);
  return match?.[1] ?? '';
}

type FleetEvidenceTokenVerification<TConnection> =
  | { ok: true; connection: TConnection }
  | { ok: false };

export interface FleetEvidenceAdmissionOptions<TConnection> {
  request: Request;
  connectionId: string;
  now: Date;
  limits: FleetEvidenceRateLimits;
  verifyToken: (input: {
    connectionId: string;
    presentedToken: string;
  }) => Promise<FleetEvidenceTokenVerification<TConnection>>;
}

export type FleetEvidenceAdmission<TConnection> =
  | { ok: true; connection: TConnection }
  | { ok: false; response: Response };

/**
 * Cheap admission path kept separate from body parsing/dispatch so its
 * ordering and independent pre-/post-auth budgets can be tested directly.
 */
export async function admitFleetEvidenceWebhook<TConnection>(
  options: FleetEvidenceAdmissionOptions<TConnection>
): Promise<FleetEvidenceAdmission<TConnection>> {
  const { request, connectionId, now, limits } = options;
  const nowMs = now.getTime();

  // 1. Size cap, header fast-path only here; the hard streamed cap runs once
  // the token has been verified (no point buffering a body for a request
  // that will be rejected as unauthorized anyway).
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const declaredBytes = Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_EVIDENCE_BODY_BYTES) {
      return { ok: false, response: jsonResponse(413, { error: 'payload_too_large' }) };
    }
  }

  // 2. Normalize malformed path input to a valid dummy lookup id. This avoids
  // a PostgreSQL UUID parse error while still sending malformed, unknown, and
  // wrong-token requests through the verifier's normalized dependency work.
  // Remember validity separately so the dummy id can never authenticate.
  const connectionIdIsValid = CONNECTION_UUID_PATTERN.test(connectionId);
  const lookupConnectionId = connectionIdIsValid ? connectionId : DUMMY_CONNECTION_ID;
  const presentedToken = extractBearerToken(request);
  if (!limits.takePreAuth(lookupConnectionId, presentedToken, nowMs)) {
    return { ok: false, response: jsonResponse(429, { error: 'rate_limited' }) };
  }

  // 3. Bound concurrent dependency work without creating a queue or a
  // process-wide fixed-window quota. Every verifier rejection receives the
  // same HTTP response; no wall-clock timing equivalence is claimed.
  const verificationRun = await limits.runVerification(() =>
    options.verifyToken({
      connectionId: lookupConnectionId,
      presentedToken
    })
  );
  if (!verificationRun.admitted) {
    return { ok: false, response: jsonResponse(429, { error: 'rate_limited' }) };
  }
  const verification = verificationRun.value;
  if (!connectionIdIsValid || !verification.ok) {
    return { ok: false, response: uniformUnauthorizedResponse() };
  }

  // 4. Only an authenticated request spends this connection's budget. A bad
  // token for a known UUID therefore cannot starve the legitimate sender.
  if (!limits.takePostAuth(connectionId, nowMs)) {
    return { ok: false, response: jsonResponse(429, { error: 'rate_limited' }) };
  }

  return { ok: true, connection: verification.connection };
}

export async function handleFleetEvidenceWebhook(
  request: Request,
  connectionId: string
): Promise<Response> {
  const now = new Date();
  const admission = await admitFleetEvidenceWebhook({
    request,
    connectionId,
    now,
    limits: rateLimits,
    // `getFleetModule()` is the SAME cached, `@vite-ignore`-guarded dynamic
    // import `@/server/admin` uses for the Dockhand/Termix live-adapter reads.
    verifyToken: async ({ connectionId: id, presentedToken }) => {
      const { getAdminServices, getFleetModule } = await import('@/server/admin');
      const { connections, connectionCredentials } = getAdminServices();
      const fleet = await getFleetModule();
      return fleet.verifyFleetIngestToken({
        connections,
        connectionCredentials,
        connectionId: id,
        presentedToken
      });
    }
  });
  if (!admission.ok) return admission.response;

  // 5. Body read (hard streamed cap) + dispatch.
  const body = await readBodyCapped(request, MAX_EVIDENCE_BODY_BYTES);
  if (!body.ok) return jsonResponse(413, { error: 'payload_too_large' });

  const { getAdminServices, getFleetModule } = await import('@/server/admin');
  const { handle, settings } = getAdminServices();
  const fleet = await getFleetModule();
  const enqueue = createTransactionalNotificationEnqueue();
  const result = await fleet.receiveFleetEvidence({
    db: handle.db,
    settings,
    connection: admission.connection,
    rawBody: body.text,
    enqueue,
    now
  });

  if (result.sourceEventId === null) {
    // Not valid JSON at all — nothing was recorded (see receiveFleetEvidence's
    // own doc for why). The sender's own bug, safe to say so.
    return jsonResponse(400, { error: 'invalid_json' });
  }

  // Never echoes the payload — a bare acknowledgement whether the evidence
  // was projected or honestly dropped (a schema mismatch, or the
  // feedback-latch). Both cases mean Loxep genuinely received the request.
  return jsonResponse(202, { received: true });
}
