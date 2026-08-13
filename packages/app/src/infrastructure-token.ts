/**
 * The `infrastructure.sync-token-policy` task — composition-root wiring for
 * Phase 7 milestone 3 (loxep-lmy.3).
 *
 * ```text
 * infrastructure.sync-token-policy   scope change (setZones / mint-with-zones)
 *      |
 *      +→ createDnsProviderTokensService(...).syncPolicy(tokenId, ...)
 *      +→ REBUILDS the token's whole provider policy from
 *         dns_provider_token_zones — never adds one zone, per the design's
 *         "a policy update replaces the entire array" rule
 * ```
 *
 * ## `mint`/`roll` are DELIBERATELY ABSENT from this file
 *
 * `tokens.ts`'s own module doc states the HARD CONSTRAINT this composition
 * must not violate: minting and rolling a token are REQUEST-SCOPED ADMIN
 * SERVER ACTIONS, never worker jobs — ADR-0022 permits the plaintext to be
 * shown to the requesting admin exactly once, *in the response to the
 * creating action*, and a job has no response to reveal into. This module
 * therefore constructs a {@link DnsProviderTokensService} and calls **only**
 * `.syncPolicy(...)` from its task handler. `.mint()` and `.roll()` exist on
 * the object (the service has one shape) but nothing here ever calls them —
 * `apps/web/src/server/admin.ts` is the one place either is invoked, from a
 * request handler, never from this registry.
 *
 * ## No live DNS-token provider adapter exists yet — this fails HONESTLY
 *
 * `@loxep/integration-cloudflare` implements zones and DNS records only;
 * token create/roll/policy endpoints are not built (see the design
 * document's implementation-status header and `cloudflare/src/index.ts`'s
 * own note that minting is "the mint-a-credential-for-a-host workflow" not
 * yet implemented). {@link buildDnsTokenProviderPort} is therefore the exact
 * same STUB `apps/web/src/server/admin.ts` wires for the web-triggered
 * `mint`/`roll` paths: every call rejects with a `provider_unavailable`
 * {@link ProviderCallError}.
 *
 * The consequence is deliberate, not an oversight: if this task IS enqueued
 * (today, only by `tokens.ts`'s own `setZones`/`mint`-with-initial-zones),
 * `syncPolicy` still writes its `reconcile_runs`/`reconcile_run_steps` rows —
 * finishing the run `failed` with `errorCode: 'provider_unavailable'`, fully
 * visible on `/infrastructure/runs` — and then throws, so Graphile Worker
 * retries with its normal exponential backoff. This is the "enqueue fails
 * visibly" choice: a handler that instead logged and returned success would
 * let an operator believe a token's zone scope had reached the provider when
 * it had not. Connection health is deliberately NOT touched here (unlike
 * `infrastructure-mail.ts`'s `ProviderCallError` handling) — this failure
 * reflects a missing Loxep adapter capability, not a problem with the DNS
 * connection's credential, and recording it against the connection would
 * misdirect an operator toward re-entering a token that is not the issue.
 *
 * Replacing {@link buildDnsTokenProviderPort} with a real adapter, once
 * `@loxep/integration-cloudflare` exposes token endpoints, is the one place
 * that needs to change — the same follow-up `admin.ts`'s stub already names.
 */
import { defineTask } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import {
  ProviderCallError,
  SYNC_TOKEN_POLICY_TASK,
  createDnsProviderTokensService,
} from "@loxep/infrastructure";
import type {
  DnsProviderTokensService,
  DnsTokenProviderPort,
} from "@loxep/infrastructure";
import { createSecretsService } from "@loxep/domain";
import { z } from "zod";
import type { AppServices } from "./services.ts";

function dnsTokenProviderUnavailable(operation: string): never {
  throw new ProviderCallError(
    "provider_unavailable",
    `DNS token ${operation} has no live provider adapter wired up yet`,
  );
}

/**
 * See the module doc's "No live DNS-token provider adapter exists yet"
 * section. Mirrors `apps/web/src/server/admin.ts`'s
 * `buildDnsTokenProviderPort` exactly — the two compositions (web request
 * path, worker job path) must fail the same honest way until a real adapter
 * lands, or an operator would see the mint dialog succeed-ish while the
 * policy sync silently behaved differently.
 */
export function buildDnsTokenProviderPort(): DnsTokenProviderPort {
  return {
    // `async` here is load-bearing, not stylistic: an ordinary arrow function
    // returning `Promise.reject(fn())` evaluates `fn()` EAGERLY, so a `fn`
    // that throws (rather than returns a value to reject with) throws
    // SYNCHRONOUSLY at the call site instead of producing a rejected
    // Promise — every real caller happens to sit inside a `try`/`await`, so
    // the bug is silent there, but it breaks the declared Promise-returning
    // contract. `async` converts the synchronous throw into a proper
    // rejection, the same way a real provider call's failure would arrive.
    mintToken: async () => dnsTokenProviderUnavailable("minting"),
    rollToken: async () => dnsTokenProviderUnavailable("rolling"),
    updatePolicy: async () => dnsTokenProviderUnavailable("policy sync"),
    findTokenById: () => Promise.resolve({ exists: false }),
  };
}

/**
 * Build the token service this composition uses. Exported so a test can
 * construct one against a stub `provider`/`secrets` pair without going
 * through `createInfrastructureTokenTasks`'s Graphile wrapper.
 */
export function createInfrastructureTokensService(
  services: AppServices,
): DnsProviderTokensService {
  return createDnsProviderTokensService({
    db: services.db,
    provider: buildDnsTokenProviderPort(),
    // The SAME nested-savepoint shape `tokens.ts`'s own doc describes:
    // `createSecretsService({ db: tx, ... })`'s internal `db.transaction`
    // becomes a SAVEPOINT inside `tokens.ts`'s outer transaction when `tx` is
    // itself a transaction handle. Irrelevant to `.syncPolicy()` (the only
    // method this composition calls), but required by the service's shape.
    secrets: (tx, input) =>
      createSecretsService({ db: tx, keyring: services.config.keyring }).setSecret(
        input,
      ),
    providerName: "cloudflare",
  });
}

const tokenPolicyPayloadSchema = z.object({
  tokenId: z.string().uuid(),
});

export interface InfrastructureTokenTasks {
  syncTokenPolicyTask: LoxepTask<typeof tokenPolicyPayloadSchema>;
  tasks: readonly LoxepTask<typeof tokenPolicyPayloadSchema>[];
}

export function createInfrastructureTokenTasks(options: {
  services: AppServices;
}): InfrastructureTokenTasks {
  const { services } = options;
  const tokens = createInfrastructureTokensService(services);

  const syncTokenPolicyTask = defineTask({
    name: SYNC_TOKEN_POLICY_TASK,
    payloadSchema: tokenPolicyPayloadSchema,
    handler: async (payload, { logger }) => {
      // `trigger: 'intent_change'` — today's only two callers
      // (`tokens.ts`'s `setZones` and `mint` with initial zones) both enqueue
      // this task in reaction to a zone-scope INTENT change, never a sweep.
      const result = await tokens.syncPolicy(payload.tokenId, {
        trigger: "intent_change",
      });
      logger.info(
        {
          tokenId: payload.tokenId,
          runId: result.runId,
          status: result.status,
          zoneCount: result.zoneCount,
          skippedUnzoned: result.skippedUnzoned,
        },
        "infrastructure dns token policy sync complete",
      );
    },
  });

  return { syncTokenPolicyTask, tasks: [syncTokenPolicyTask] };
}
