/**
 * Server functions for the `/settings/storage` migrate-objects affordance
 * (loxep-7fs, A15).
 *
 * `packages/storage/src/migration.ts` shipped a complete, tested, resumable
 * copy→verify(sha256)→transactional cutover→cleanup local↔S3 migration
 * workflow (`StorageMigrationService`) with zero importers outside its own
 * test, and its `storage.migrate-object` worker task was unregistered until
 * this session's own P0 fix (`packages/app/src/storage-migration.ts`,
 * loxep-vdt) — so the task now runs, but nothing could ever start a
 * migration: `storage-backends-table/index.tsx` rendered a placeholder Alert
 * promising a migration UI "arrives in a later phase". This file is the
 * enqueue path; `@/server/admin.ts`'s `getStorageMigrationService()` builds
 * the service against the shared pool's `@loxep/jobs` standalone `addJob`
 * (see that getter's own doc — no started worker runner is required for a
 * request to start or resume a migration).
 *
 * This is a NEW file, not an addition to `admin-functions.ts` — storage
 * BACKEND registration/testing already lives there and is a sibling
 * surface's fence (see this bead's fences); storage MIGRATION is a
 * genuinely separate concern with its own service, own read model
 * (`storage_migrations`/`storage_migration_objects`), and no shared state
 * with backend registration beyond reading the backend list.
 *
 * Role gate: `requireAdmin` throughout — starting a migration moves data
 * between infrastructure backends and is squarely an administrative action,
 * matching `registerStorageBackend`'s own gate in `admin-functions.ts`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export interface StorageBackendOptionDto {
  id: string;
  name: string;
  driver: string;
  isDefault: boolean;
}

/** The source/destination pickers' options — every registered backend, secrets never included. */
export const fetchStorageBackendOptions = createServerFn({ method: 'GET' }).handler(
  async (): Promise<StorageBackendOptionDto[]> => {
    const { requireAdmin, getStorageBackendsService } = await import('@/server/admin');
    await requireAdmin();
    const storageBackends = await getStorageBackendsService();
    const backends = await storageBackends.listBackends();
    return backends.map((backend) => ({
      id: backend.id,
      name: backend.name,
      driver: backend.driver,
      isDefault: backend.isDefault
    }));
  }
);

export interface StorageMigrationDto {
  id: string;
  sourceBackendId: string;
  destinationBackendId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  counts: {
    pending: number;
    done: number;
    skipped: number;
    failed: number;
    total: number;
  };
}

const startStorageMigrationInput = z.strictObject({
  sourceBackendId: z.uuid(),
  destinationBackendId: z.uuid()
});

export const startStorageMigration = createServerFn({ method: 'POST' })
  .inputValidator(startStorageMigrationInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireAdmin, getStorageMigrationService } = await import('@/server/admin');
    const session = await requireAdmin();
    const migrations = await getStorageMigrationService();
    const migration = await migrations.startMigration({
      sourceBackendId: data.sourceBackendId,
      destinationBackendId: data.destinationBackendId,
      createdByUserId: session.user.id
    });
    return { id: migration.id };
  });

export const resumeStorageMigration = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ enqueued: number }> => {
    const { requireAdmin, getStorageMigrationService } = await import('@/server/admin');
    await requireAdmin();
    const migrations = await getStorageMigrationService();
    return migrations.resumeMigration(data.id);
  });

export const fetchStorageMigrationStatus = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<StorageMigrationDto> => {
    const { requireAdmin, getStorageMigrationService } = await import('@/server/admin');
    await requireAdmin();
    const migrations = await getStorageMigrationService();
    const { migration, counts } = await migrations.getMigrationStatus(data.id);
    return {
      id: migration.id,
      sourceBackendId: migration.sourceBackendId,
      destinationBackendId: migration.destinationBackendId,
      status: migration.status,
      startedAt: iso(migration.startedAt),
      completedAt: iso(migration.completedAt),
      createdAt: iso(migration.createdAt),
      counts
    };
  });

export interface StorageMigrationCleanupResultDto {
  deleted: number;
  skipped: number;
  failures: { mediaObjectId: string; error: string }[];
}

/**
 * `StorageMigrationService.cleanupMigrationSources` — explicit, LATER
 * source deletion, never automatic and never part of the copy/verify path.
 * The service itself refuses when the migration is not yet
 * `completed`/`completed_with_errors`.
 */
export const cleanupStorageMigrationSources = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<StorageMigrationCleanupResultDto> => {
    const { requireAdmin, getStorageMigrationService } = await import('@/server/admin');
    await requireAdmin();
    const migrations = await getStorageMigrationService();
    return migrations.cleanupMigrationSources(data.id);
  });
