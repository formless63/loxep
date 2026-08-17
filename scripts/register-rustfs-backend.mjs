#!/usr/bin/env node
/**
 * One-off, container-run (see the `one-off-scripts-against-the-live-loxep-stack`
 * bd memory and `mint-qa-session.mjs`'s precedent): registers the Compose
 * `rustfs` companion as an in-app `s3` storage backend, through the REAL
 * `StorageBackendsService` — so the credential lands application-encrypted in
 * `application_secrets` via the keyring, never as plaintext or raw SQL.
 *
 * Creates the bucket first (idempotent), refuses to run twice (a backend
 * with the same name already registered), and never touches the default
 * backend unless --make-default is passed.
 *
 *   docker compose exec \
 *     -e RUSTFS_ACCESS_KEY -e RUSTFS_SECRET_KEY \
 *     loxep node scripts/register-rustfs-backend.mjs --i-know-this-registers-a-backend
 */
import { loadBootstrapConfig } from "@loxep/config";
import { createDb, closeDb } from "@loxep/db";
import { createStorageBackendsService } from "@loxep/storage";
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

const NAME = "rustfs-test";
const ENDPOINT = "http://rustfs:9000";
const REGION = "us-east-1";
const BUCKET = "loxep-media";

if (!process.argv.includes("--i-know-this-registers-a-backend")) {
  console.error("refusing: pass --i-know-this-registers-a-backend");
  process.exit(2);
}
const accessKeyId = process.env["RUSTFS_ACCESS_KEY"];
const secretAccessKey = process.env["RUSTFS_SECRET_KEY"];
if (!accessKeyId || !secretAccessKey) {
  console.error("refusing: RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY not in env");
  process.exit(2);
}

const config = loadBootstrapConfig({ ...process.env, LOXEP_MODE: "worker" });
const handle = createDb(config.databaseUrl);
const { db } = handle;

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
try {
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  console.log(`bucket "${BUCKET}" already exists`);
} catch {
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  console.log(`bucket "${BUCKET}" created`);
}

const service = createStorageBackendsService({ db, keyring: config.keyring });
const existing = (await service.listBackends()).find((b) => b.name === NAME);
if (existing) {
  console.log(`backend "${NAME}" already registered (${existing.id}) — nothing to do`);
} else {
  const backend = await service.registerBackend({
    name: NAME,
    driver: "s3",
    config: { endpoint: ENDPOINT, region: REGION, bucket: BUCKET },
    credentials: { accessKeyId, secretAccessKey },
    makeDefault: process.argv.includes("--make-default"),
  });
  console.log(`registered "${NAME}" (${backend.id}), default=${backend.isDefault}`);
}
await closeDb(handle);
