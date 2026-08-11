/**
 * First-admin bootstrap (configuration-and-secrets.md "First administrator
 * and recovery"): the first successful sign-in matching the bootstrap email
 * (case-insensitively) is granted `admin` exactly once, completion is
 * recorded in `application_settings`, and the grant is never repeated —
 * demoting the user and signing in again leaves them `member`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  createAuth,
  FIRST_ADMIN_BOOTSTRAP_SETTING_KEY,
  type LoxepAuth,
} from "../src/index.ts";
import type { FirstAdminBootstrapRecord, MagicLinkEmail } from "../src/index.ts";
import {
  captureMagicLinkEmails,
  createMigratedScratchDb,
  dropScratchDb,
  signInWithMagicLink,
  testBootstrapConfig,
} from "./helpers.ts";

// Deliberately differently-cased from the sign-in email below.
const BOOTSTRAP_EMAIL = "Owner@Example.com";
const SIGN_IN_EMAIL = "owner@example.com";

let databaseName: string;
let databaseUrl: string;
let db: DbHandle;
let auth: LoxepAuth;
let emails: MagicLinkEmail[];

beforeAll(async () => {
  ({ databaseName, databaseUrl } = await createMigratedScratchDb(
    "loxep_auth_bootstrap",
  ));
  db = createDb(databaseUrl);
  const captured = captureMagicLinkEmails();
  emails = captured.emails;
  auth = createAuth({
    config: testBootstrapConfig(databaseUrl, {
      bootstrapAdminEmail: BOOTSTRAP_EMAIL,
    }),
    db,
    sendMagicLinkEmail: captured.sender,
  });
});

afterAll(async () => {
  await closeDb(db);
  await dropScratchDb(databaseName);
});

describe("first-admin bootstrap", () => {
  it("does not grant admin to non-matching users, even on the first sign-in ever", async () => {
    const { cookie } = await signInWithMagicLink(
      auth,
      emails,
      "bystander@example.com",
    );
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.role).toBe("member");

    const marker = await db.db.query.applicationSettings.findFirst({
      where: (table, { eq }) =>
        eq(table.key, FIRST_ADMIN_BOOTSTRAP_SETTING_KEY),
    });
    expect(marker).toBeUndefined();
  });

  it("grants admin once on first matching sign-in (case-insensitive) and records completion", async () => {
    const { cookie } = await signInWithMagicLink(auth, emails, SIGN_IN_EMAIL);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.role).toBe("admin");

    const userRow = await db.db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, SIGN_IN_EMAIL),
    });
    expect(userRow?.role).toBe("admin");

    const marker = await db.db.query.applicationSettings.findFirst({
      where: (table, { eq }) =>
        eq(table.key, FIRST_ADMIN_BOOTSTRAP_SETTING_KEY),
    });
    expect(marker).toBeDefined();
    const record = marker!.value as FirstAdminBootstrapRecord;
    expect(record.userId).toBe(userRow!.id);
    expect(record.email).toBe(SIGN_IN_EMAIL);
    expect(Date.parse(record.completedAt)).not.toBeNaN();
  });

  it("never re-grants: after an explicit demotion, signing in again stays member", async () => {
    // Demote via SQL, simulating a deliberate later role change.
    await db.pool.query(`update "user" set role = 'member' where email = $1`, [
      SIGN_IN_EMAIL,
    ]);

    const { cookie } = await signInWithMagicLink(auth, emails, SIGN_IN_EMAIL);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.role).toBe("member");

    const userRow = await db.db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, SIGN_IN_EMAIL),
    });
    expect(userRow?.role).toBe("member");
  });
});
