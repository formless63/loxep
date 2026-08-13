#!/usr/bin/env node
/**
 * QA session mint (loxep-kw3) — dev-only helper for Playwright QA against a
 * live Loxep deployment now that SMTP is real (Purelymail) and
 * Mailpit-captured magic links are no longer reachable there.
 *
 * This is a one-off container script, not a workspace package (see bd
 * memory `one-off-scripts-against-the-live-loxep-stack`): `docker cp` it
 * into the running app container's `/app`, then run it with
 * `docker compose exec -T <service> node /app/mint-qa-session.mjs ...` so it
 * resolves `@loxep/config` / `@loxep/db` / `better-auth` / `better-call`
 * from the container's own installed node_modules — module resolution fails
 * from outside `/app`. Delete the copy from the container afterward
 * (`docker compose exec -u root -T <service> rm /app/mint-qa-session.mjs`).
 *
 * It inserts a real Better Auth `session` row for an existing user and
 * derives the exact `Set-Cookie` value a real sign-in would produce, by
 * calling better-auth's and better-call's own exported cookie functions
 * (`better-auth/cookies` `getCookies`, `better-call` `serializeSignedCookie`)
 * — never reimplementing the HMAC-SHA256 signing itself. See
 * `apps/web/e2e/helpers/qa-session.ts` for the Playwright side that consumes
 * the JSON this writes.
 *
 * HARD GATES:
 *   - the target user must already exist — this never creates one;
 *   - `--i-know-this-mints-a-session` must be passed explicitly.
 *
 * Output discipline: nothing is ever written to stdout except the single
 * line `WROTE <path>` on success. The email argument, the session token,
 * and the signed cookie value are never logged anywhere (stdout, stderr, or
 * thrown-error messages) — they only ever reach the output JSON file (mode
 * 600). That file must be written to the caller's scratchpad and deleted as
 * soon as the Playwright run that consumes it finishes.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { loadBootstrapConfig } from "@loxep/config";
import { createDb, closeDb, schema } from "@loxep/db";
import { getCookies } from "better-auth/cookies";
import { serializeSignedCookie } from "better-call";

/** Minted session lifetime — short-lived on purpose (QA convenience, not a real login). */
const SESSION_TTL_SECONDS = 2 * 60 * 60;

/** Marks rows/requests created by this script, so cleanup can target them precisely. */
const QA_MINT_MARKER = "qa-mint";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const gate = args.includes("--i-know-this-mints-a-session");
  const positionals = args.filter((arg) => !arg.startsWith("--"));
  const [email, outPath] = positionals;

  if (!email || !outPath) {
    fail(
      "usage: mint-qa-session.mjs <email> <output-json-path> --i-know-this-mints-a-session",
    );
    return;
  }
  if (!gate) {
    fail(
      "refusing: pass --i-know-this-mints-a-session to confirm this mints a live session row",
    );
    return;
  }

  const config = loadBootstrapConfig(process.env);
  if (config.authSecret === undefined || config.publicOrigin === undefined) {
    fail(
      "refusing: LOXEP_AUTH_SECRET / LOXEP_PUBLIC_ORIGIN are not configured in this environment",
    );
    return;
  }

  const dbHandle = createDb(config.databaseUrl);
  try {
    const [user] = await dbHandle.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);

    if (!user) {
      fail("refusing: target user does not exist");
      return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    const token = randomBytes(32).toString("base64url");

    await dbHandle.db.insert(schema.session).values({
      id: randomUUID(),
      token,
      userId: user.id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      ipAddress: QA_MINT_MARKER,
      userAgent: QA_MINT_MARKER,
    });

    // Cookie name + attributes: exactly what @loxep/auth's createAuth()
    // computes at runtime (it sets no `advanced` overrides), reused via
    // better-auth's own getCookies() rather than re-derived by hand.
    const cookies = getCookies({
      baseURL: config.publicOrigin,
      session: { expiresIn: SESSION_TTL_SECONDS },
    });
    const cookieName = cookies.sessionToken.name;

    // Cookie value: better-call's own signer — the same function
    // `ctx.setSignedCookie` calls from better-auth's `setSessionCookie`
    // (HMAC-SHA256 over the raw token, standard-base64 signature,
    // `${token}.${signature}`, percent-encoded). `serializeSignedCookie`
    // returns a full `Set-Cookie` line (`${cookieName}=${value}` plus any
    // attributes from `opt`) — and its internal `_serialize` helper has a
    // side effect worth knowing about: because our cookie name starts with
    // `__Secure-`, it mutates the (otherwise empty) `opt` to set
    // `secure: true` and appends a trailing `; Secure`, even though we pass
    // no attributes in. `encodeURIComponent` already escaped every literal
    // `;` the signed value itself could contain, so cutting at the first
    // `;` safely discards that (and any future) attribute suffix and
    // leaves only the encoded value.
    const line = await serializeSignedCookie(cookieName, token, config.authSecret, {});
    const nameValue = line.split(";")[0];
    const cookieValue = nameValue.slice(cookieName.length + 1);

    const payload = {
      cookieName,
      cookieValue,
      expiresAt: expiresAt.toISOString(),
    };
    writeFileSync(outPath, JSON.stringify(payload), { mode: 0o600 });
    process.stdout.write(`WROTE ${outPath}\n`);
  } finally {
    await closeDb(dbHandle);
  }
}

main().catch((error) => {
  fail(`mint failed: ${error instanceof Error ? error.constructor.name : "Error"}`);
  process.exitCode = 1;
});
