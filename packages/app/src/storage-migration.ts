/**
 * `storage.migrate-object` — composition-root wiring for `@loxep/storage`'s
 * resumable local→S3 migration (ADR-0012 §"Local-to-S3 migration", ADR-0014
 * §7).
 *
 * ```text
 * storage.migrate-object   one job per media object, key
 *                          storage.migrate-object:{migrationId}:{mediaObjectId}
 *      +→ StorageMigrationService.migrateObject(migrationId, mediaObjectId)
 *         copy → verify (size + sha256 re-hashed from a STREAMED destination
 *         read) → metadata cutover in one transaction → source left intact
 * ```
 *
 * ## Why this file is three lines of wiring and no logic
 *
 * Unlike every other module in this composition, the task here already
 * existed in full: `migration.ts` builds it with `defineTask` inside
 * `createStorageMigrationService` and its own module doc says "register it in
 * the worker runtime's task registry alongside this service". Nobody ever
 * did (loxep-vdt) — the service was reachable only from its own package
 * test, so the handler had no home in the worker and a started migration
 * would have queued jobs Graphile Worker could not resolve. This module is
 * the missing registration, not a new implementation.
 *
 * ## The `addJob` cycle, and how it is broken
 *
 * `createStorageMigrationService` takes an `addJob` so `startMigration` /
 * `resumeMigration` can enqueue one job per object, and the job it enqueues
 * is the very task this service constructs. `migration.ts`'s own doc names
 * the resolution ("a closure over it, since the runtime is usually started
 * with this service's task already in its registry"), and that is exactly
 * what happens here: the enqueue closes over the shared pool through
 * `@loxep/jobs`' standalone `addJob`, which writes `graphile_worker.jobs`
 * directly and needs no started runner. Building the service is therefore
 * free of any ordering constraint against `startWorkerRuntime`.
 *
 * ## Idempotency (at-least-once, ADR-0003)
 *
 * The handler is idempotent by construction and this module adds nothing to
 * that story, so the reasoning is recorded rather than reinvented: an object
 * whose `media_objects.storage_backend_id` has already cut over to the
 * destination short-circuits to `done` without a byte moved; the copy is a
 * `put` under the object's stable storage key, which is convergent; the
 * cutover and the `done` status commit in one transaction; the per-object row
 * is a composite-key upsert, never an insert that could collide; and the
 * source object is never deleted by this path at all (cleanup is a separate,
 * explicit call). A redelivery of a completed object is a read and a status
 * upsert to the value it already holds. The stable `jobKey` additionally
 * dedupes a re-enqueue from `resumeMigration` against a job still pending.
 *
 * A verification failure is deliberately NOT idempotent-by-silence: it
 * deletes the bad destination copy, records the mismatch on the object row,
 * performs no cutover, and throws so the job retries per policy.
 */
import { addJob as standaloneAddJob } from "@loxep/jobs";
import { createStorageBackendsService } from "@loxep/storage";
// The migration surface deliberately lives behind its own subpath so
// importers that need only drivers/backends/media do not pull @loxep/jobs in
// transitively (`@loxep/storage`'s index doc). A worker composition root is
// exactly the importer that SHOULD reach for it.
import { createStorageMigrationService } from "@loxep/storage/migration";
import type { StorageMigrationService } from "@loxep/storage/migration";
import type { AppServices } from "./services.ts";

/** `@loxep/storage`'s own task, plus the service that enqueues and runs it. */
export interface StorageMigrationTasks {
  migrateObjectTask: StorageMigrationService["task"];
  /** Exposed so a caller can start/resume/inspect a migration on the SAME instance the worker runs. */
  migrations: StorageMigrationService;
  tasks: readonly StorageMigrationService["task"][];
}

export function createStorageMigrationTasks(options: {
  services: AppServices;
}): StorageMigrationTasks {
  const { services } = options;

  // The SAME construction `documents-extraction.ts`'s `buildMediaService` and
  // `apps/web/src/server/admin.ts`'s `getMediaService()` use — backends need
  // the keyring because an `s3` backend's credentials are encrypted at rest.
  const backends = createStorageBackendsService({
    db: services.db,
    keyring: services.config.keyring,
  });

  const migrations = createStorageMigrationService({
    db: services.db,
    backends,
    // See the module doc's "addJob cycle": the standalone enqueue works
    // against the shared pool, so no started runner is required to build
    // this service.
    addJob: (task, payload, enqueueOptions) =>
      standaloneAddJob(services.handle.pool, task, payload, enqueueOptions),
  });

  return {
    migrateObjectTask: migrations.task,
    migrations,
    tasks: [migrations.task],
  };
}
