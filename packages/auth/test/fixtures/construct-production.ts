/**
 * Subprocess fixture for production-env.test.ts: constructs the runtime auth
 * instance under NODE_ENV=production with only LOXEP_* configuration — no
 * BETTER_AUTH_SECRET / BETTER_AUTH_URL — proving the compose env mirror is
 * unnecessary. Prints PRODUCTION_CONSTRUCTION_OK on success.
 */
import { loadBootstrapConfig } from "@loxep/config";
import { closeDb, createDb } from "@loxep/db";
import { createAuth } from "../../src/index.ts";

if (process.env.NODE_ENV !== "production") {
  throw new Error("fixture must run with NODE_ENV=production");
}
if (process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_URL) {
  throw new Error("fixture must run without BETTER_AUTH_* variables");
}

const config = loadBootstrapConfig();
const db = createDb(config.databaseUrl);
const auth = createAuth({ config, db });

// Await full context initialization: this is where Better Auth validates the
// secret (and, in production, throws on a missing/default one).
const context = await auth.$context;
if (context.secret !== config.authSecret) {
  throw new Error("auth context secret does not match bootstrap config");
}

// Exercise the API surface without a cookie: resolves to null, no DB access.
const session = await auth.api.getSession({ headers: new Headers() });
if (session !== null) {
  throw new Error("expected no session for an unauthenticated request");
}

await closeDb(db);
console.log("PRODUCTION_CONSTRUCTION_OK");
