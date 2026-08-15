/**
 * Fleet alert evidence webhook handler (Phase 8 milestone 7, loxep-ovj.7) —
 * reached ONLY from `routes/api.v1.hooks.fleet.$connectionId.ts`'s `POST`
 * handler, via a dynamic import. Loxep's first inbound integration surface:
 * UNAUTHENTICATED BY SESSION, authenticated by a per-connection bearer token
 * alone (`@loxep/app`'s `verifyFleetIngestToken`).
 *
 * Order matters, and mirrors the design's own list exactly:
 *
 * 1. rate-limit (per `connectionId`, in-memory — see the note below)
 * 2. size-cap (`Content-Length` fast-reject, then a hard streamed cap —
 *    BOTH before any parsing)
 * 3. constant-time token verification; a bad token and an unknown
 *    connection are INDISTINGUISHABLE (`identicalUnauthorized()` is the
 *    ONE response object every failure reason returns)
 * 4. body read + `receiveFleetEvidence` (JSON parsing, provider dispatch,
 *    the `source_events` write, the transactional projection enqueue)
 *
 * The response NEVER echoes the payload back, at any step.
 *
 * ## In-memory rate limiting is a deliberate, documented trade-off
 *
 * The contract forbids Redis/Kafka/BullMQ (Graphile Worker on PostgreSQL is
 * the accepted job system) and a per-request DB write just to rate-limit
 * would add load to the one path that most needs to stay cheap under abuse.
 * A fixed-window counter keyed by `connectionId`, held in process memory, is
 * therefore the honest MVP: it resets on deploy and does not share state
 * across `LOXEP_MODE=web` replicas, but it stops a single misbehaving or
 * compromised token from hammering the ingest path within one process,
 * which is the threat this milestone's blast-radius analysis names.
 */
import { createTransactionalNotificationEnqueue } from '@loxep/domain';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS_PER_WINDOW = 30;
/** Cheap unbounded-growth guard — see `pruneRateLimitState`'s doc. */
const RATE_LIMIT_MAX_TRACKED_KEYS = 5_000;

/** `MAX_EVIDENCE_BODY_BYTES` — alert/backup-status JSON bodies are tiny; 64KB is generous headroom. */
const MAX_EVIDENCE_BODY_BYTES = 64 * 1024;

interface RateWindow {
  count: number;
  windowStart: number;
}

/** Module-level, per-process state — see the module doc's rate-limiting note. */
const rateLimitState = new Map<string, RateWindow>();

function pruneRateLimitState(now: number): void {
  // Only scanned when the tracked-key count crosses the cap, so the common
  // case (a handful of configured sources) never pays this cost.
  if (rateLimitState.size <= RATE_LIMIT_MAX_TRACKED_KEYS) return;
  for (const [key, window] of rateLimitState) {
    if (now - window.windowStart >= RATE_LIMIT_WINDOW_MS) rateLimitState.delete(key);
  }
}

/** True when `key` is still within its budget for this window. */
function checkRateLimit(key: string, now: number): boolean {
  pruneRateLimitState(now);
  const existing = rateLimitState.get(key);
  if (existing === undefined || now - existing.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(key, { count: 1, windowStart: now });
    return true;
  }
  existing.count += 1;
  return existing.count <= RATE_LIMIT_MAX_REQUESTS_PER_WINDOW;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * The ONE response every authentication failure returns — an unknown
 * `connectionId`, a connection that is not an evidence-ingest one, a missing
 * `Authorization` header, and a wrong token are all this exact object.
 */
function identicalUnauthorized(): Response {
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

export async function handleFleetEvidenceWebhook(
  request: Request,
  connectionId: string
): Promise<Response> {
  const now = new Date();

  // 1. Rate limit — cheap, keyed on the URL param alone, before any DB call.
  if (!checkRateLimit(connectionId, now.getTime())) {
    return jsonResponse(429, { error: 'rate_limited' });
  }

  // 2. Size cap, header fast-path only here; the hard streamed cap runs once
  // the token has been verified (no point buffering a body for a request
  // that will be rejected as unauthorized anyway).
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const declaredBytes = Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_EVIDENCE_BODY_BYTES) {
      return jsonResponse(413, { error: 'payload_too_large' });
    }
  }

  // 3. Constant-time token verification. `getFleetModule()` is the SAME
  // cached, `@vite-ignore`-guarded dynamic import `@/server/admin` already
  // uses for the Dockhand/Termix live-adapter reads — reused here rather
  // than a second ad-hoc `import('@loxep/app')`, which (as a literal string
  // specifier) Vite would try to statically bundle for SSR, exactly the
  // hazard `getFleetModule()`'s own doc explains.
  const { getAdminServices, getFleetModule } = await import('@/server/admin');
  const { connections, connectionCredentials, handle, settings } = getAdminServices();
  const fleet = await getFleetModule();

  const verification = await fleet.verifyFleetIngestToken({
    connections,
    connectionCredentials,
    connectionId,
    presentedToken: extractBearerToken(request)
  });
  if (!verification.ok) return identicalUnauthorized();

  // 4. Body read (hard streamed cap) + dispatch.
  const body = await readBodyCapped(request, MAX_EVIDENCE_BODY_BYTES);
  if (!body.ok) return jsonResponse(413, { error: 'payload_too_large' });

  const enqueue = createTransactionalNotificationEnqueue();
  const result = await fleet.receiveFleetEvidence({
    db: handle.db,
    settings,
    connection: verification.connection,
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
