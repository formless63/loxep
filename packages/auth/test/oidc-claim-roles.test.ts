/**
 * OIDC claim → `admin` mapping (ADR-0024 §6, loxep-x2s).
 *
 * The claim decoding and matching helpers are pure and tested directly. The
 * role application is tested against real `user`/`account` rows carrying a
 * crafted id_token — the same shape Better Auth persists during the OAuth
 * callback — which exercises every precedence rule (create-only versus
 * every-sign-in, promotion, demotion, and the last-administrator guard)
 * without needing an identity provider.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  applyOidcClaimRole,
  claimGrantsAdmin,
  claimMappingEnabled,
  claimTokens,
  decodeIdTokenClaims,
  DEFAULT_PROVISIONING_POLICY,
  OIDC_PROVIDER_ID,
  resolveClaimPath,
  type AuthProvisioningPolicy,
  type ClaimApplyMoment,
} from "../src/index.ts";
import { createMigratedScratchDb, dropScratchDb } from "./helpers.ts";

let databaseName: string;
let databaseUrl: string;
let db: DbHandle;

/** An unsigned JWT carrying `claims` — only the payload is ever read. */
function idTokenFor(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function policyWith(
  overrides: Partial<AuthProvisioningPolicy["oidcAdminClaim"]>,
): AuthProvisioningPolicy {
  return {
    ...DEFAULT_PROVISIONING_POLICY,
    oidcAdminClaim: {
      claim: "groups",
      adminValues: ["loxep-admins"],
      applyOn: "create",
      ...overrides,
    },
  };
}

interface SeedOptions {
  role?: string | null;
  idToken?: string | null;
  providerId?: string;
  withAccount?: boolean;
}

/** Insert a user (and by default its OIDC account) and return the user id. */
async function seedUser(id: string, options: SeedOptions = {}): Promise<string> {
  await db.pool.query(
    `insert into "user" (id, name, email, email_verified, role, updated_at)
     values ($1, $1, $1 || '@example.com', true, $2, now())`,
    [id, options.role ?? "member"],
  );
  if (options.withAccount !== false) {
    await db.pool.query(
      `insert into account (id, account_id, provider_id, user_id, id_token, updated_at)
       values ($1, $1, $2, $3, $4, now())`,
      [
        `${id}-account`,
        options.providerId ?? OIDC_PROVIDER_ID,
        id,
        options.idToken ?? null,
      ],
    );
  }
  return id;
}

async function roleOf(userId: string): Promise<string | null> {
  const result = await db.pool.query<{ role: string | null }>(
    `select role from "user" where id = $1`,
    [userId],
  );
  return result.rows[0]?.role ?? null;
}

async function apply(
  userId: string,
  policy: AuthProvisioningPolicy,
  moment: "create" | "sign_in",
) {
  return applyOidcClaimRole(db, {
    userId,
    policy,
    moment,
    providerId: OIDC_PROVIDER_ID,
  });
}

beforeAll(async () => {
  ({ databaseName, databaseUrl } = await createMigratedScratchDb(
    "loxep_auth_claims",
  ));
  db = createDb(databaseUrl);
});

afterAll(async () => {
  await closeDb(db);
  await dropScratchDb(databaseName);
});

afterEach(async () => {
  await db.pool.query(`delete from account`);
  await db.pool.query(`delete from "user"`);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("decodeIdTokenClaims", () => {
  it("decodes the payload of a well-formed token", () => {
    expect(decodeIdTokenClaims(idTokenFor({ sub: "abc", groups: ["a"] }))).toEqual({
      sub: "abc",
      groups: ["a"],
    });
  });

  it("returns null for anything that is not a three-part JSON-object token", () => {
    expect(decodeIdTokenClaims(null)).toBeNull();
    expect(decodeIdTokenClaims(undefined)).toBeNull();
    expect(decodeIdTokenClaims("")).toBeNull();
    expect(decodeIdTokenClaims("header.payload")).toBeNull();
    expect(decodeIdTokenClaims("a.!!!not-base64!!!.c")).toBeNull();
    expect(decodeIdTokenClaims(idTokenFor([] as unknown as Record<string, unknown>))).toBeNull();
  });
});

describe("resolveClaimPath", () => {
  const claims = {
    groups: ["ops", "loxep-admins"],
    realm_access: { roles: ["default"] },
    empty: null,
  };

  it("resolves a top-level and a nested path", () => {
    expect(resolveClaimPath(claims, "groups")).toEqual(["ops", "loxep-admins"]);
    expect(resolveClaimPath(claims, "realm_access.roles")).toEqual(["default"]);
  });

  it("returns undefined for a missing segment or a path through a non-object", () => {
    expect(resolveClaimPath(claims, "missing")).toBeUndefined();
    expect(resolveClaimPath(claims, "realm_access.missing")).toBeUndefined();
    expect(resolveClaimPath(claims, "groups.roles")).toBeUndefined();
    expect(resolveClaimPath(claims, "")).toBeUndefined();
  });
});

describe("claimTokens", () => {
  it("yields each entry of an array claim", () => {
    expect(claimTokens(["ops", "loxep-admins"])).toEqual(["ops", "loxep-admins"]);
  });

  it("yields both the whole string and its whitespace-separated tokens", () => {
    expect(claimTokens("users loxep-admins")).toEqual([
      "users loxep-admins",
      "users",
      "loxep-admins",
    ]);
    expect(claimTokens("loxep-admins")).toEqual(["loxep-admins"]);
  });

  it("stringifies numbers and booleans and ignores everything else", () => {
    expect(claimTokens(7)).toEqual(["7"]);
    expect(claimTokens(true)).toEqual(["true"]);
    expect(claimTokens({ nested: "value" })).toEqual([]);
    expect(claimTokens(null)).toEqual([]);
    expect(claimTokens(undefined)).toEqual([]);
  });
});

describe("claimGrantsAdmin", () => {
  it("matches an array claim case-insensitively", () => {
    expect(
      claimGrantsAdmin({ groups: ["ops", "LOXEP-Admins"] }, policyWith({}).oidcAdminClaim),
    ).toBe(true);
  });

  it("matches a space-delimited string claim", () => {
    expect(
      claimGrantsAdmin({ groups: "users loxep-admins" }, policyWith({}).oidcAdminClaim),
    ).toBe(true);
  });

  it("does not match when the value is absent or different", () => {
    expect(claimGrantsAdmin({ groups: ["ops"] }, policyWith({}).oidcAdminClaim)).toBe(
      false,
    );
    expect(claimGrantsAdmin({}, policyWith({}).oidcAdminClaim)).toBe(false);
    expect(claimGrantsAdmin(null, policyWith({}).oidcAdminClaim)).toBe(false);
  });

  it("is inert when no claim or no admin values are configured", () => {
    expect(
      claimGrantsAdmin({ groups: ["loxep-admins"] }, policyWith({ claim: null }).oidcAdminClaim),
    ).toBe(false);
    expect(
      claimGrantsAdmin(
        { groups: ["loxep-admins"] },
        policyWith({ adminValues: [] }).oidcAdminClaim,
      ),
    ).toBe(false);
  });
});

describe("claimMappingEnabled", () => {
  it("requires both a claim path and at least one admin value", () => {
    expect(claimMappingEnabled(DEFAULT_PROVISIONING_POLICY)).toBe(false);
    expect(claimMappingEnabled(policyWith({ claim: null }))).toBe(false);
    expect(claimMappingEnabled(policyWith({ adminValues: [] }))).toBe(false);
    expect(claimMappingEnabled(policyWith({}))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Applying the mapping
// ---------------------------------------------------------------------------

describe("applyOidcClaimRole", () => {
  it("does nothing when the mapping is not configured", async () => {
    const id = await seedUser("unconfigured", {
      idToken: idTokenFor({ groups: ["loxep-admins"] }),
    });
    expect(await apply(id, DEFAULT_PROVISIONING_POLICY, "create")).toBe(
      "not_configured",
    );
    expect(await roleOf(id)).toBe("member");
  });

  it.each<[ClaimApplyMoment, "create" | "sign_in"]>([
    ["create", "sign_in"],
    ["every_sign_in", "create"],
  ])(
    "with applyOn=%s it does not run from the %s hook",
    async (applyOn, moment) => {
      const id = await seedUser(`moment-${applyOn}`, {
        idToken: idTokenFor({ groups: ["loxep-admins"] }),
      });
      expect(await apply(id, policyWith({ applyOn }), moment)).toBe(
        "skipped_create_only",
      );
      expect(await roleOf(id)).toBe("member");
    },
  );

  it("reports no OIDC account when the user has none", async () => {
    const id = await seedUser("magic-link-only", { withAccount: false });
    expect(await apply(id, policyWith({}), "create")).toBe("no_oidc_account");
  });

  it("reports no claims when the account carries no readable id_token", async () => {
    const id = await seedUser("tokenless", { idToken: null });
    expect(await apply(id, policyWith({}), "create")).toBe("no_claims");
    expect(await roleOf(id)).toBe("member");
  });

  it("grants admin at account creation when the claim matches", async () => {
    const id = await seedUser("newcomer", {
      idToken: idTokenFor({ groups: ["ops", "loxep-admins"] }),
    });
    expect(await apply(id, policyWith({}), "create")).toBe("promoted");
    expect(await roleOf(id)).toBe("admin");
  });

  it("leaves a non-matching new user alone at creation", async () => {
    const id = await seedUser("ordinary", {
      idToken: idTokenFor({ groups: ["ops"] }),
    });
    expect(await apply(id, policyWith({}), "create")).toBe("unchanged");
    expect(await roleOf(id)).toBe("member");
  });

  it("never demotes under applyOn=create — a manual role edit is permanent", async () => {
    // The operator promoted this person inside Loxep; the IdP says nothing.
    const id = await seedUser("hand-promoted", {
      role: "admin",
      idToken: idTokenFor({ groups: ["ops"] }),
    });
    // Another admin exists, so a demotion would be permitted if it were tried.
    await seedUser("other-admin", { role: "admin", withAccount: false });
    expect(await apply(id, policyWith({}), "create")).toBe("unchanged");
    expect(await roleOf(id)).toBe("admin");
  });

  it("promotes on every sign-in when the IdP is authoritative", async () => {
    const id = await seedUser("sso-admin", {
      idToken: idTokenFor({ realm_access: { roles: ["loxep-admins"] } }),
    });
    expect(
      await apply(
        id,
        policyWith({ claim: "realm_access.roles", applyOn: "every_sign_in" }),
        "sign_in",
      ),
    ).toBe("promoted");
    expect(await roleOf(id)).toBe("admin");
  });

  it("demotes on every sign-in when the claim no longer matches", async () => {
    const id = await seedUser("removed-from-group", {
      role: "admin",
      idToken: idTokenFor({ groups: ["ops"] }),
    });
    await seedUser("surviving-admin", { role: "admin", withAccount: false });
    expect(
      await apply(id, policyWith({ applyOn: "every_sign_in" }), "sign_in"),
    ).toBe("demoted");
    expect(await roleOf(id)).toBe("member");
  });

  it("refuses to demote the only remaining administrator", async () => {
    const id = await seedUser("last-admin", {
      role: "admin",
      idToken: idTokenFor({ groups: ["ops"] }),
    });
    await seedUser("a-member", { withAccount: false });
    expect(
      await apply(id, policyWith({ applyOn: "every_sign_in" }), "sign_in"),
    ).toBe("demotion_skipped_last_admin");
    expect(await roleOf(id)).toBe("admin");
  });

  it("is idempotent when the role already matches the claim", async () => {
    const id = await seedUser("already-right", {
      role: "admin",
      idToken: idTokenFor({ groups: ["loxep-admins"] }),
    });
    expect(
      await apply(id, policyWith({ applyOn: "every_sign_in" }), "sign_in"),
    ).toBe("unchanged");
    expect(await roleOf(id)).toBe("admin");
  });

  it("ignores an account belonging to a different provider", async () => {
    const id = await seedUser("other-provider", {
      providerId: "credential",
      idToken: idTokenFor({ groups: ["loxep-admins"] }),
    });
    expect(await apply(id, policyWith({}), "create")).toBe("no_oidc_account");
    expect(await roleOf(id)).toBe("member");
  });
});
