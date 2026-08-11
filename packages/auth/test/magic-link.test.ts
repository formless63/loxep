/**
 * Magic-link login end-to-end against the real database: request a link via
 * the server API with a captured sender, verify the token, and confirm a
 * session exists for the user (with the default `member` role).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createAuth, type LoxepAuth } from "../src/index.ts";
import type { MagicLinkEmail } from "../src/index.ts";
import {
  captureMagicLinkEmails,
  cookieHeaderFrom,
  createMigratedScratchDb,
  dropScratchDb,
  testBootstrapConfig,
} from "./helpers.ts";

let databaseName: string;
let databaseUrl: string;
let db: DbHandle;
let auth: LoxepAuth;
let emails: MagicLinkEmail[];

beforeAll(async () => {
  ({ databaseName, databaseUrl } = await createMigratedScratchDb(
    "loxep_auth_magic",
  ));
  db = createDb(databaseUrl);
  const captured = captureMagicLinkEmails();
  emails = captured.emails;
  auth = createAuth({
    config: testBootstrapConfig(databaseUrl),
    db,
    sendMagicLinkEmail: captured.sender,
  });
});

afterAll(async () => {
  await closeDb(db);
  await dropScratchDb(databaseName);
});

describe("magic-link login", () => {
  it("delivers a link, verifies the token, and establishes a session", async () => {
    const email = "alice@example.com";

    const requested = await auth.api.signInMagicLink({
      body: { email },
      headers: new Headers(),
    });
    expect(requested.status).toBe(true);

    // The captured email carries the verification URL and token; nothing was
    // actually sent over SMTP.
    expect(emails).toHaveLength(1);
    const delivered = emails[0]!;
    expect(delivered.to).toBe(email);
    const url = new URL(delivered.url);
    expect(url.pathname).toBe("/api/auth/magic-link/verify");
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    expect(delivered.token).toBe(token);

    const { headers, response } = await auth.api.magicLinkVerify({
      query: { token: token! },
      headers: new Headers(),
      returnHeaders: true,
    });
    expect(response.user.email).toBe(email);
    expect(response.session.userId).toBe(response.user.id);

    // The session is real: it exists in the database ...
    const sessionRow = await db.db.query.session.findFirst({
      where: (table, { eq }) => eq(table.userId, response.user.id),
    });
    expect(sessionRow).toBeDefined();
    expect(sessionRow?.token).toBe(response.session.token);

    // ... and the returned cookie authenticates follow-up API calls.
    const sessionData = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeaderFrom(headers) }),
    });
    expect(sessionData?.user.email).toBe(email);

    // Ordinary sign-up receives the default deployment role `member`.
    expect(sessionData?.user.role).toBe("member");
  });

  it("rejects an already-consumed token", async () => {
    const email = "bob@example.com";
    await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
    const delivered = emails.at(-1)!;
    const token = new URL(delivered.url).searchParams.get("token")!;

    await auth.api.magicLinkVerify({
      query: { token },
      headers: new Headers(),
    });
    await expect(
      auth.api.magicLinkVerify({ query: { token }, headers: new Headers() }),
    ).rejects.toThrowError();
  });

  it("fails delivery loudly when SMTP is unconfigured and no sender is injected", async () => {
    const config = testBootstrapConfig(databaseUrl, {
      withSmtp: false,
      withOidc: true,
    });
    const smtpless = createAuth({ config, db });
    await expect(
      smtpless.api.signInMagicLink({
        body: { email: "carol@example.com" },
        headers: new Headers(),
      }),
    ).rejects.toThrowError();
  });
});
