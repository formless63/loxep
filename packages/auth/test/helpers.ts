/**
 * Test helpers: scratch-database lifecycle against the dev database
 * (docker/compose.dev.yml, host port 5433) plus auth-specific fixtures.
 *
 * Each test file creates its own scratch database so files can run in
 * parallel and never depend on leftover state.
 */
import { randomBytes } from "node:crypto";
import { loadBootstrapConfig, type BootstrapConfig } from "@loxep/config";
import { closeDb, createDb } from "@loxep/db";
import { runMigrations } from "@loxep/db/migrate";
import type { LoxepAuth } from "../src/create-auth.ts";
import type { MagicLinkEmail } from "../src/magic-link-email.ts";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";

export const baseDatabaseUrl =
  process.env.LOXEP_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

/** URL pointing at the server's maintenance database. */
function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

/** URL for a named database on the same server. */
export function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function scratchDbName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export async function createScratchDb(databaseName: string): Promise<string> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(
      `create database "${databaseName}" template template0`,
    );
  } finally {
    await closeDb(handle);
  }
  return databaseUrlFor(databaseName);
}

export async function dropScratchDb(databaseName: string): Promise<void> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(
      `drop database if exists "${databaseName}" with (force)`,
    );
  } finally {
    await closeDb(handle);
  }
}

/** Silent logger so migration chatter does not pollute test output. */
export const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Create a scratch database and apply all Loxep migrations to it. */
export async function createMigratedScratchDb(prefix: string): Promise<{
  databaseName: string;
  databaseUrl: string;
}> {
  const databaseName = scratchDbName(prefix);
  const databaseUrl = await createScratchDb(databaseName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  return { databaseName, databaseUrl };
}

/** Valid ADR-0019 keyring document (one active 256-bit key). */
export function testKeyringJson(): string {
  return JSON.stringify({
    active_version: 1,
    keys: { "1": randomBytes(32).toString("base64") },
  });
}

export const TEST_PUBLIC_ORIGIN = "http://localhost:3020";

/** Valid synthetic discovery metadata for the test-only OIDC issuer. */
export function testOidcDiscoveryResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    issuer: "https://id.test.invalid",
    authorization_endpoint: "https://id.test.invalid/authorize",
    token_endpoint: "https://id.test.invalid/token",
    userinfo_endpoint: "https://id.test.invalid/userinfo",
    jwks_uri: "https://id.test.invalid/jwks",
    id_token_signing_alg_values_supported: ["RS256"],
    ...overrides,
  });
}

export interface TestConfigOverrides {
  bootstrapAdminEmail?: string;
  withOidc?: boolean;
  withSmtp?: boolean;
}

/**
 * Real `loadBootstrapConfig()` output for tests: web-serving mode with the
 * SMTP login path (and optionally OIDC) configured against the scratch
 * database. Using the actual loader keeps fixtures honest about what a
 * deployment can express.
 */
export function testBootstrapConfig(
  databaseUrl: string,
  overrides: TestConfigOverrides = {},
): BootstrapConfig {
  const env: Record<string, string | undefined> = {
    LOXEP_MODE: "all",
    LOXEP_DATABASE_URL: databaseUrl,
    LOXEP_PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
    LOXEP_AUTH_SECRET: "test-auth-secret-0123456789abcdef0123456789abcdef",
    LOXEP_KEYRING: testKeyringJson(),
  };
  if (overrides.withSmtp !== false) {
    env.LOXEP_SMTP_URL = "smtp://mailer.test.invalid:2525";
    env.LOXEP_SMTP_FROM = "loxep@test.invalid";
  }
  if (overrides.withOidc) {
    env.LOXEP_OIDC_ISSUER = "https://id.test.invalid";
    env.LOXEP_OIDC_CLIENT_ID = "loxep-test-client";
    env.LOXEP_OIDC_CLIENT_SECRET = "test-oidc-client-secret";
  }
  if (overrides.bootstrapAdminEmail !== undefined) {
    env.LOXEP_BOOTSTRAP_ADMIN_EMAIL = overrides.bootstrapAdminEmail;
  }
  return loadBootstrapConfig(env);
}

/** Mailbox capturing magic-link emails instead of sending them. */
export function captureMagicLinkEmails(): {
  emails: MagicLinkEmail[];
  sender: (email: MagicLinkEmail) => Promise<void>;
} {
  const emails: MagicLinkEmail[] = [];
  return {
    emails,
    sender: async (email) => {
      emails.push(email);
    },
  };
}

/** First `cookie:`-header value from a Better Auth `set-cookie` response. */
export function cookieHeaderFrom(responseHeaders: Headers): string {
  const setCookies = responseHeaders.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error("expected set-cookie headers on the response");
  }
  return setCookies
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .filter((pair) => pair !== "")
    .join("; ");
}

/**
 * Complete a magic-link sign-in for `email` against `auth`, returning the
 * session cookie header for follow-up authenticated API calls.
 */
export async function signInWithMagicLink(
  auth: LoxepAuth,
  emails: MagicLinkEmail[],
  email: string,
): Promise<{ cookie: string }> {
  const before = emails.length;
  await auth.api.signInMagicLink({
    body: { email },
    headers: new Headers(),
  });
  const delivered = emails[before];
  if (!delivered) throw new Error("magic link email was not captured");
  const token = new URL(delivered.url).searchParams.get("token");
  if (!token) throw new Error("magic link URL carries no token");
  const { headers } = await auth.api.magicLinkVerify({
    query: { token },
    headers: new Headers(),
    returnHeaders: true,
  });
  return { cookie: cookieHeaderFrom(headers) };
}
