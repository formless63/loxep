/**
 * Deployment-level roles (ADR-0017): default `member` on ordinary sign-in,
 * role persisted on the user row, admin-only server APIs gated on `admin`,
 * and the `requireRole` guard for later server code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  AuthorizationError,
  createAuth,
  hasRole,
  requireRole,
  sessionRoles,
  type LoxepAuth,
} from "../src/index.ts";
import type { MagicLinkEmail } from "../src/index.ts";
import {
  captureMagicLinkEmails,
  createMigratedScratchDb,
  dropScratchDb,
  signInWithMagicLink,
  testBootstrapConfig,
} from "./helpers.ts";

const ADMIN_EMAIL = "root@example.com";
const MEMBER_EMAIL = "member@example.com";

let databaseName: string;
let databaseUrl: string;
let db: DbHandle;
let auth: LoxepAuth;
let emails: MagicLinkEmail[];

beforeAll(async () => {
  ({ databaseName, databaseUrl } = await createMigratedScratchDb(
    "loxep_auth_roles",
  ));
  db = createDb(databaseUrl);
  const captured = captureMagicLinkEmails();
  emails = captured.emails;
  auth = createAuth({
    // First-admin bootstrap promotes ADMIN_EMAIL on first sign-in, giving
    // the test a real admin without touching SQL.
    config: testBootstrapConfig(databaseUrl, {
      bootstrapAdminEmail: ADMIN_EMAIL,
    }),
    db,
    sendMagicLinkEmail: captured.sender,
  });
});

afterAll(async () => {
  await closeDb(db);
  await dropScratchDb(databaseName);
});

describe("admin/member roles", () => {
  it("persists the default member role on the user row at ordinary sign-up", async () => {
    const { cookie } = await signInWithMagicLink(auth, emails, MEMBER_EMAIL);
    const sessionData = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(sessionData?.user.role).toBe("member");

    const row = await db.db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, MEMBER_EMAIL),
    });
    expect(row?.role).toBe("member");
  });

  it("gates admin server APIs on the admin role", async () => {
    const admin = await signInWithMagicLink(auth, emails, ADMIN_EMAIL);
    const member = await signInWithMagicLink(auth, emails, MEMBER_EMAIL);

    // Admin capability: listing users via the admin API.
    const listed = await auth.api.listUsers({
      query: { limit: 10 },
      headers: new Headers({ cookie: admin.cookie }),
    });
    expect(listed.users.length).toBeGreaterThanOrEqual(2);

    // The same call as a member is refused.
    await expect(
      auth.api.listUsers({
        query: { limit: 10 },
        headers: new Headers({ cookie: member.cookie }),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // setRole is likewise admin-only ...
    const memberRow = await db.db.query.user.findFirst({
      where: (table, { eq }) => eq(table.email, MEMBER_EMAIL),
    });
    await expect(
      auth.api.setRole({
        body: { userId: memberRow!.id, role: "admin" },
        headers: new Headers({ cookie: member.cookie }),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // ... and as admin it persists the role change on the user row.
    const promoted = await auth.api.setRole({
      body: { userId: memberRow!.id, role: "admin" },
      headers: new Headers({ cookie: admin.cookie }),
    });
    expect(promoted.user.role).toBe("admin");
    const promotedRow = await db.db.query.user.findFirst({
      where: (table, { eq }) => eq(table.id, memberRow!.id),
    });
    expect(promotedRow?.role).toBe("admin");

    // Restore for other assertions in this file.
    await auth.api.setRole({
      body: { userId: memberRow!.id, role: "member" },
      headers: new Headers({ cookie: admin.cookie }),
    });
  });
});

describe("requireRole guard", () => {
  it("passes sessions holding the role and returns them for chaining", () => {
    const adminSession = { user: { role: "admin" } };
    expect(requireRole(adminSession, "admin")).toBe(adminSession);
    expect(hasRole(adminSession, "admin")).toBe(true);
    expect(hasRole(adminSession, "member")).toBe(false);
  });

  it("treats a missing role as member, never admin", () => {
    const bare = { user: {} };
    expect(sessionRoles(bare)).toEqual(["member"]);
    expect(requireRole(bare, "member")).toBe(bare);
    expect(() => requireRole(bare, "admin")).toThrowError(AuthorizationError);
  });

  it("handles comma-separated multi-role values", () => {
    const both = { user: { role: "admin,member" } };
    expect(hasRole(both, "admin")).toBe(true);
    expect(hasRole(both, "member")).toBe(true);
  });

  it("rejects unauthenticated callers with 401 and non-admins with 403", () => {
    try {
      requireRole(null, "admin");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).statusCode).toBe(401);
    }
    try {
      requireRole({ user: { role: "member" } }, "admin");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).statusCode).toBe(403);
    }
  });
});
