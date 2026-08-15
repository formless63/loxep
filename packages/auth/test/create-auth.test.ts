/**
 * `createAuth()` construction: explicit/lazy factory, config wiring, and
 * OIDC provider registration derived from bootstrap configuration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { loadBootstrapConfig } from "@loxep/config";
import {
  buildOidcProviderConfig,
  createAuth,
  mapOidcProfileToUser,
  OIDC_PROVIDER_ID,
} from "../src/index.ts";
import {
  captureMagicLinkEmails,
  createMigratedScratchDb,
  dropScratchDb,
  testBootstrapConfig,
  testKeyringJson,
  TEST_PUBLIC_ORIGIN,
} from "./helpers.ts";

let databaseName: string;
let databaseUrl: string;
let db: DbHandle;

beforeAll(async () => {
  ({ databaseName, databaseUrl } = await createMigratedScratchDb(
    "loxep_auth_create",
  ));
  db = createDb(databaseUrl);
});

afterAll(async () => {
  await closeDb(db);
  await dropScratchDb(databaseName);
});

describe("createAuth", () => {
  it("builds an instance wired from bootstrap config (no BETTER_AUTH_* env)", async () => {
    const config = testBootstrapConfig(databaseUrl);
    const { sender } = captureMagicLinkEmails();
    const auth = createAuth({ config, db, sendMagicLinkEmail: sender });

    expect(auth.options.secret).toBe(config.authSecret);
    expect(auth.options.baseURL).toBe(TEST_PUBLIC_ORIGIN);
    expect(auth.options.trustedOrigins).toEqual([TEST_PUBLIC_ORIGIN]);
    expect(auth.options.emailAndPassword?.enabled).toBe(false);

    // Construction is explicit and side-effect free until used; the context
    // initializes successfully from Loxep config alone.
    const context = await auth.$context;
    expect(context.secret).toBe(config.authSecret);
  });

  it("requires web-serving bootstrap facts", () => {
    const workerConfig = loadBootstrapConfig({
      LOXEP_MODE: "worker",
      LOXEP_DATABASE_URL: databaseUrl,
      LOXEP_KEYRING: testKeyringJson(),
    });
    expect(() => createAuth({ config: workerConfig, db })).toThrowError(
      /authSecret/,
    );
  });

  it("registers the generic OIDC provider only when config.oidc is present", () => {
    const { sender } = captureMagicLinkEmails();

    const withOidc = createAuth({
      config: testBootstrapConfig(databaseUrl, { withOidc: true }),
      db,
      sendMagicLinkEmail: sender,
    });
    const oauthPlugin = withOidc.options.plugins.find(
      (plugin) => plugin.id === "generic-oauth",
    );
    expect(oauthPlugin).toBeDefined();
    const providers = (
      oauthPlugin as unknown as {
        options: { config: Array<{ providerId: string; discoveryUrl?: string }> };
      }
    ).options.config;
    expect(providers).toHaveLength(1);
    expect(providers[0]?.providerId).toBe(OIDC_PROVIDER_ID);
    expect(providers[0]?.discoveryUrl).toBe(
      "https://id.test.invalid/.well-known/openid-configuration",
    );

    const withoutOidc = createAuth({
      config: testBootstrapConfig(databaseUrl),
      db,
      sendMagicLinkEmail: sender,
    });
    const emptyPlugin = withoutOidc.options.plugins.find(
      (plugin) => plugin.id === "generic-oauth",
    );
    // The plugin itself stays registered (schema parity with generation);
    // no provider entries exist without bootstrap OIDC config.
    expect(emptyPlugin).toBeDefined();
    expect(
      (emptyPlugin as unknown as { options: { config: unknown[] } }).options
        .config,
    ).toHaveLength(0);
  });

  it("derives the OIDC provider generically from the issuer (Pocket ID compatible)", () => {
    const provider = buildOidcProviderConfig({
      issuer: "https://pocket-id.example.com/",
      clientId: "client",
      clientSecret: "secret",
      emailClaim: "email",
    });
    expect(provider.providerId).toBe("oidc");
    expect(provider.discoveryUrl).toBe(
      "https://pocket-id.example.com/.well-known/openid-configuration",
    );
    expect(provider.pkce).toBe(true);
    expect(provider.scopes).toEqual(["openid", "profile", "email"]);
  });

  it("declares the displayName profile column as a Better Auth additional field", () => {
    const { sender } = captureMagicLinkEmails();
    const auth = createAuth({
      config: testBootstrapConfig(databaseUrl),
      db,
      sendMagicLinkEmail: sender,
    });
    const displayName = auth.options.user?.additionalFields?.["displayName"];
    expect(displayName).toMatchObject({
      type: "string",
      required: false,
      input: true,
    });
  });

  it("seeds displayName from OIDC claims without ever re-syncing the profile", () => {
    const provider = buildOidcProviderConfig({
      issuer: "https://pocket-id.example.com",
      clientId: "client",
      clientSecret: "secret",
      emailClaim: "email",
    });
    // `overrideUserInfo` stays unset: Better Auth then applies provider values
    // only when creating the user, so an in-app override survives every later
    // sign-in.
    expect(provider.overrideUserInfo).toBeUndefined();
    // `emailClaim: "email"` is the standard claim, so the wrapper behaves
    // identically to calling `mapOidcProfileToUser` with no override.
    expect(provider.mapProfileToUser?.({ given_name: "William" })).toEqual(
      mapOidcProfileToUser({ given_name: "William" }),
    );

    // `name`/`picture` are mapped by the plugin itself, so the hook adds only
    // displayName — nickname first, then preferred_username, then given_name.
    expect(
      mapOidcProfileToUser({
        name: "Alex Rivera",
        picture: "https://pocket-id.example.com/avatar.png",
        nickname: "Will",
        preferred_username: "arivera",
        given_name: "William",
      }),
    ).toEqual({ displayName: "Will" });
    expect(
      mapOidcProfileToUser({ preferred_username: "arivera", given_name: "William" }),
    ).toEqual({ displayName: "arivera" });
    expect(mapOidcProfileToUser({ given_name: " William " })).toEqual({
      displayName: "William",
    });
    expect(mapOidcProfileToUser({ nickname: "   ", name: "Alex Rivera" })).toEqual(
      {},
    );
    expect(mapOidcProfileToUser({})).toEqual({});
  });

  describe("LOXEP_OIDC_EMAIL_CLAIM (loxep-yk8)", () => {
    it("defaults to the standard 'email' claim and never touches the profile", () => {
      expect(
        mapOidcProfileToUser({ email: "person@example.com", given_name: "Person" }),
      ).toEqual({ displayName: "Person" });
      expect(mapOidcProfileToUser({ email: "person@example.com" })).toEqual({});
    });

    it("a user whose email lives in a custom claim creates correctly", () => {
      const provider = buildOidcProviderConfig({
        issuer: "https://id.example.com",
        clientId: "client",
        clientSecret: "secret",
        emailClaim: "acme_email",
      });
      expect(
        provider.mapProfileToUser?.({
          acme_email: "  Person@Example.com ",
          given_name: "Person",
        }),
      ).toEqual({ displayName: "Person", email: "Person@Example.com" });
    });

    it("absence of the configured claim fails legibly: no email field, so Better Auth's own missing-email path takes over", () => {
      const provider = buildOidcProviderConfig({
        issuer: "https://id.example.com",
        clientId: "client",
        clientSecret: "secret",
        emailClaim: "acme_email",
      });
      // No `acme_email` claim on the profile at all.
      expect(provider.mapProfileToUser?.({ given_name: "Person" })).toEqual({
        displayName: "Person",
      });
      // A blank claim value is treated the same as absent.
      expect(
        provider.mapProfileToUser?.({ acme_email: "   ", given_name: "Person" }),
      ).toEqual({ displayName: "Person" });
      // A non-string claim value is treated the same as absent.
      expect(
        provider.mapProfileToUser?.({ acme_email: 12345, given_name: "Person" }),
      ).toEqual({ displayName: "Person" });
    });
  });
});
