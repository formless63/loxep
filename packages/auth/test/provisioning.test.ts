/**
 * Account provisioning policy (ADR-0024, loxep-x2s).
 *
 * Two layers are covered here against a real database and a real Better Auth
 * instance: the send-time gate in `sendMagicLink`, and the authoritative
 * `user.create.before` gate that both sign-in methods reach.
 *
 * The OIDC leg cannot run an end-to-end flow in-package — there is no identity
 * provider — so its enforcement is proven at the decision function the hook
 * delegates to (`decideProvisioning` via `mayCreateUser`, keyed on the OAuth
 * callback's declared endpoint path), which is the same code path the hook
 * executes. The magic-link leg is exercised end to end.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  AUTH_PROVISIONING_SETTING_KEY,
  createAuth,
  decideProvisioning,
  DEFAULT_PROVISIONING_POLICY,
  emailDomainAllowed,
  installationHasAdmin,
  mayCreateUser,
  parseProvisioningPolicy,
  provisioningMethodForPath,
  readProvisioningPolicy,
  type AuthProvisioningPolicy,
  type LoxepAuth,
  type MagicLinkEmail,
} from "../src/index.ts";
import {
  captureMagicLinkEmails,
  createMigratedScratchDb,
  dropScratchDb,
  signInWithMagicLink,
  testBootstrapConfig,
} from "./helpers.ts";

const BOOTSTRAP_EMAIL = "owner@example.com";

let databaseName: string;
let databaseUrl: string;
let db: DbHandle;
let auth: LoxepAuth;
let emails: MagicLinkEmail[];

/** Store a policy, merged over the shipped default. */
async function setPolicy(
  overrides: Partial<AuthProvisioningPolicy>,
): Promise<void> {
  const value: AuthProvisioningPolicy = {
    ...DEFAULT_PROVISIONING_POLICY,
    ...overrides,
  };
  await db.pool.query(
    `insert into application_settings (key, value)
     values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [AUTH_PROVISIONING_SETTING_KEY, JSON.stringify(value)],
  );
}

async function clearPolicy(): Promise<void> {
  await db.pool.query(`delete from application_settings where key = $1`, [
    AUTH_PROVISIONING_SETTING_KEY,
  ]);
}

/** Make the installation look bootstrapped (closes the bootstrap window). */
async function ensureAdminExists(): Promise<void> {
  await db.pool.query(
    `insert into "user" (id, name, email, email_verified, role)
     values ('fixture-admin', 'Fixture Admin', 'fixture-admin@example.com', true, 'admin')
     on conflict (id) do update set role = 'admin'`,
  );
}

async function removeAdmins(): Promise<void> {
  await db.pool.query(`delete from "user" where id = 'fixture-admin'`);
  await db.pool.query(`update "user" set role = 'member' where role = 'admin'`);
}

async function userRow(
  email: string,
): Promise<{ id: string; role: string | null } | undefined> {
  const result = await db.pool.query<{ id: string; role: string | null }>(
    `select id, role from "user" where lower(email) = lower($1)`,
    [email],
  );
  return result.rows[0];
}

/** Request a magic link and report whether one was actually delivered. */
async function requestMagicLink(email: string): Promise<{
  delivered: MagicLinkEmail | undefined;
  status: unknown;
}> {
  const before = emails.length;
  const status = await auth.api.signInMagicLink({
    body: { email },
    headers: new Headers(),
  });
  return { delivered: emails[before], status };
}

beforeAll(async () => {
  ({ databaseName, databaseUrl } = await createMigratedScratchDb(
    "loxep_auth_provisioning",
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

afterEach(async () => {
  await clearPolicy();
});

// ---------------------------------------------------------------------------
// The total parser
// ---------------------------------------------------------------------------

describe("parseProvisioningPolicy", () => {
  it("returns the shipped default for a missing or non-object value", () => {
    expect(parseProvisioningPolicy(undefined)).toEqual(
      DEFAULT_PROVISIONING_POLICY,
    );
    expect(parseProvisioningPolicy(null)).toEqual(DEFAULT_PROVISIONING_POLICY);
    expect(parseProvisioningPolicy("open")).toEqual(DEFAULT_PROVISIONING_POLICY);
    expect(parseProvisioningPolicy([])).toEqual(DEFAULT_PROVISIONING_POLICY);
  });

  it("reads a well-formed stored policy verbatim", () => {
    const stored = {
      newUsers: { magicLink: "open", oidc: "closed" },
      magicLinkEmailDomains: ["Example.com", " other.test "],
      oidcAdminClaim: {
        claim: "groups",
        adminValues: ["loxep-admins"],
        applyOn: "every_sign_in",
      },
    };
    expect(parseProvisioningPolicy(stored)).toEqual({
      newUsers: { magicLink: "open", oidc: "closed" },
      magicLinkEmailDomains: ["Example.com", "other.test"],
      oidcAdminClaim: {
        claim: "groups",
        adminValues: ["loxep-admins"],
        applyOn: "every_sign_in",
      },
    });
  });

  it("degrades every malformed field to the safe default rather than throwing", () => {
    const parsed = parseProvisioningPolicy({
      newUsers: { magicLink: "sometimes", oidc: 42 },
      magicLinkEmailDomains: ["ok.test", 7, "", "   "],
      oidcAdminClaim: { claim: "   ", adminValues: "loxep-admins", applyOn: "yes" },
    });
    // Unreadable stances fall back to CLOSED — drift can only ever make this
    // layer more restrictive than the operator's stored value.
    expect(parsed.newUsers).toEqual({ magicLink: "closed", oidc: "closed" });
    expect(parsed.magicLinkEmailDomains).toEqual(["ok.test"]);
    expect(parsed.oidcAdminClaim).toEqual({
      claim: null,
      adminValues: [],
      applyOn: "create",
    });
  });
});

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

describe("emailDomainAllowed", () => {
  it("allows everything when the list is empty", () => {
    expect(emailDomainAllowed("anyone@anywhere.test", [])).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(emailDomainAllowed("Person@Example.COM", ["example.com"])).toBe(true);
    expect(emailDomainAllowed("person@example.com", ["EXAMPLE.com"])).toBe(true);
  });

  it("does not treat a parent domain as a wildcard over its subdomains", () => {
    expect(emailDomainAllowed("person@sub.example.com", ["example.com"])).toBe(
      false,
    );
  });

  it("rejects an address with no parseable domain", () => {
    expect(emailDomainAllowed("not-an-email", ["example.com"])).toBe(false);
    expect(emailDomainAllowed("trailing@", ["example.com"])).toBe(false);
  });
});

describe("provisioningMethodForPath", () => {
  it("maps each user-creating endpoint to its method", () => {
    expect(provisioningMethodForPath("/magic-link/verify")).toBe("magic_link");
    expect(provisioningMethodForPath("/oauth2/callback/:providerId")).toBe("oidc");
    expect(provisioningMethodForPath("/oauth2/callback/oidc")).toBe("oidc");
    expect(provisioningMethodForPath("/admin/create-user")).toBe("admin");
  });

  it("treats an absent or unrecognized path as unknown", () => {
    expect(provisioningMethodForPath(undefined)).toBe("unknown");
    expect(provisioningMethodForPath(null)).toBe("unknown");
    expect(provisioningMethodForPath("")).toBe("unknown");
    expect(provisioningMethodForPath("/sign-up/email")).toBe("unknown");
  });
});

describe("decideProvisioning", () => {
  const closed = DEFAULT_PROVISIONING_POLICY;
  const open: AuthProvisioningPolicy = {
    ...DEFAULT_PROVISIONING_POLICY,
    newUsers: { magicLink: "open", oidc: "open" },
  };

  it("permits everything while the installation has no administrator", () => {
    for (const method of ["magic_link", "oidc", "unknown"] as const) {
      expect(
        decideProvisioning({
          method,
          email: "stranger@elsewhere.test",
          policy: closed,
          installationHasAdmin: false,
        }),
      ).toEqual({ allowed: true });
    }
  });

  it("blocks a new magic-link user once the method is closed", () => {
    expect(
      decideProvisioning({
        method: "magic_link",
        email: "stranger@elsewhere.test",
        policy: closed,
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: false, reason: "method_closed" });
  });

  it("blocks a new OIDC user once the method is closed", () => {
    expect(
      decideProvisioning({
        method: "oidc",
        email: "stranger@elsewhere.test",
        policy: closed,
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: false, reason: "method_closed" });
  });

  it("closes the two methods independently", () => {
    const oidcOnly: AuthProvisioningPolicy = {
      ...DEFAULT_PROVISIONING_POLICY,
      newUsers: { magicLink: "closed", oidc: "open" },
    };
    expect(
      decideProvisioning({
        method: "oidc",
        policy: oidcOnly,
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: true });
    expect(
      decideProvisioning({
        method: "magic_link",
        email: "a@b.test",
        policy: oidcOnly,
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: false, reason: "method_closed" });
  });

  it("applies the domain allowlist to an open magic-link method", () => {
    const allowlisted: AuthProvisioningPolicy = {
      ...open,
      magicLinkEmailDomains: ["example.com"],
    };
    expect(
      decideProvisioning({
        method: "magic_link",
        email: "person@example.com",
        policy: allowlisted,
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: true });
    expect(
      decideProvisioning({
        method: "magic_link",
        email: "person@other.test",
        policy: allowlisted,
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: false, reason: "email_domain_not_allowed" });
  });

  it("never applies the domain allowlist to the OIDC method", () => {
    expect(
      decideProvisioning({
        method: "oidc",
        email: "person@other.test",
        policy: { ...open, magicLinkEmailDomains: ["example.com"] },
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("always allows the admin-created path — it is the escape hatch", () => {
    expect(
      decideProvisioning({
        method: "admin",
        email: "invited@anywhere.test",
        policy: { ...closed, magicLinkEmailDomains: ["example.com"] },
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("blocks an unrecognized creation path only when both methods are closed", () => {
    expect(
      decideProvisioning({
        method: "unknown",
        policy: closed,
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: false, reason: "method_closed" });
    expect(
      decideProvisioning({
        method: "unknown",
        policy: { ...closed, newUsers: { magicLink: "open", oidc: "closed" } },
        installationHasAdmin: true,
      }),
    ).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Database-backed reads
// ---------------------------------------------------------------------------

describe("policy reads", () => {
  it("returns the shipped default when no row is stored", async () => {
    expect(await readProvisioningPolicy(db)).toEqual(DEFAULT_PROVISIONING_POLICY);
  });

  it("reads the stored row", async () => {
    await setPolicy({ newUsers: { magicLink: "open", oidc: "open" } });
    expect((await readProvisioningPolicy(db)).newUsers).toEqual({
      magicLink: "open",
      oidc: "open",
    });
  });

  it("detects the bootstrap window from the presence of an admin user", async () => {
    await removeAdmins();
    expect(await installationHasAdmin(db)).toBe(false);
    await ensureAdminExists();
    expect(await installationHasAdmin(db)).toBe(true);
    await removeAdmins();
  });
});

// ---------------------------------------------------------------------------
// End-to-end magic link, and the OIDC branch of the same gate
// ---------------------------------------------------------------------------

describe("magic-link provisioning", () => {
  afterEach(async () => {
    await removeAdmins();
  });

  it("provisions freely while no administrator exists (bootstrap window)", async () => {
    await removeAdmins();
    await setPolicy({}); // stored default: both methods closed
    const { delivered } = await requestMagicLink("first-arrival@elsewhere.test");
    expect(delivered).toBeDefined();
  });

  it("does not send a link to an unknown address once signups are closed", async () => {
    await ensureAdminExists();
    await setPolicy({});
    const { delivered, status } = await requestMagicLink("stranger@elsewhere.test");
    expect(delivered).toBeUndefined();
    // Identical response either way: the endpoint must not become an
    // account-existence oracle.
    expect(status).toEqual({ status: true });
    expect(await userRow("stranger@elsewhere.test")).toBeUndefined();
  });

  it("still sends a link to an EXISTING user while signups are closed", async () => {
    await removeAdmins();
    await setPolicy({ newUsers: { magicLink: "open", oidc: "closed" } });
    await signInWithMagicLink(auth, emails, "resident@elsewhere.test");
    expect(await userRow("resident@elsewhere.test")).toBeDefined();

    await ensureAdminExists();
    await setPolicy({});
    const { delivered } = await requestMagicLink("resident@elsewhere.test");
    expect(delivered).toBeDefined();
  });

  it("refuses an unknown address outside the domain allowlist, and admits one inside it", async () => {
    await ensureAdminExists();
    await setPolicy({
      newUsers: { magicLink: "open", oidc: "closed" },
      magicLinkEmailDomains: ["allowed.test"],
    });

    const outside = await requestMagicLink("nope@other.test");
    expect(outside.delivered).toBeUndefined();

    const inside = await requestMagicLink("yes@allowed.test");
    expect(inside.delivered).toBeDefined();
  });

  it("blocks user creation at verification time for a link issued before signups closed", async () => {
    await ensureAdminExists();
    await setPolicy({ newUsers: { magicLink: "open", oidc: "closed" } });
    const { delivered } = await requestMagicLink("late@elsewhere.test");
    expect(delivered).toBeDefined();

    // The policy changes between issue and redemption — layer 2 is what makes
    // a still-valid link stop working.
    await setPolicy({});
    const token = new URL(delivered!.url).searchParams.get("token");
    await expect(
      auth.api.magicLinkVerify({
        query: { token: token! },
        headers: new Headers(),
        returnHeaders: true,
      }),
    ).rejects.toThrow();
    expect(await userRow("late@elsewhere.test")).toBeUndefined();
  });

  it("leaves the first-admin bootstrap path working with the closed default stored", async () => {
    await removeAdmins();
    await setPolicy({});
    await signInWithMagicLink(auth, emails, BOOTSTRAP_EMAIL);
    const row = await userRow(BOOTSTRAP_EMAIL);
    expect(row?.role).toBe("admin");
    // ...and the bootstrap window has now closed behind it.
    expect(await installationHasAdmin(db)).toBe(true);
  });
});

describe("the user.create.before gate", () => {
  afterEach(async () => {
    await removeAdmins();
  });

  it("blocks the OIDC callback path when the OIDC method is closed", async () => {
    await ensureAdminExists();
    await setPolicy({ newUsers: { magicLink: "open", oidc: "closed" } });
    expect(
      await mayCreateUser(db, {
        path: "/oauth2/callback/:providerId",
        email: "sso@elsewhere.test",
      }),
    ).toEqual({ allowed: false, reason: "method_closed" });
  });

  it("admits the OIDC callback path when the OIDC method is open", async () => {
    await ensureAdminExists();
    await setPolicy({ newUsers: { magicLink: "closed", oidc: "open" } });
    expect(
      await mayCreateUser(db, {
        path: "/oauth2/callback/:providerId",
        email: "sso@elsewhere.test",
      }),
    ).toEqual({ allowed: true });
  });

  it("admits /admin/create-user even with both methods closed", async () => {
    await ensureAdminExists();
    await setPolicy({});
    expect(
      await mayCreateUser(db, {
        path: "/admin/create-user",
        email: "invited@elsewhere.test",
      }),
    ).toEqual({ allowed: true });
  });

  it("lets an admin create a user through Better Auth while signups are closed", async () => {
    await ensureAdminExists();
    await setPolicy({});
    // No password: email+password is disabled (ADR-0007), and the admin
    // plugin's `password` field is optional for exactly this case.
    await auth.api.createUser({
      body: { email: "invited@elsewhere.test", name: "Invited Person" },
    });
    const row = await userRow("invited@elsewhere.test");
    expect(row).toBeDefined();
    expect(row?.role).toBe("member");
  });
});
