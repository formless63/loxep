/**
 * Mint a Medusa v2 secret API key against the local `medusa-verify` harness and
 * write `~/.config/loxep/medusa.env` (mode 0600) — the file
 * `loadMedusaCredentialsFromEnvFile()` reads and every Medusa live suite skips
 * on when absent.
 *
 * Prints ONLY non-secret confirmation (key id, type, redacted form, token
 * LENGTH, HTTP statuses). The token itself is never logged — the same
 * discipline the live suites use, where a thrown message is rebuilt from
 * hand-written labels so a vitest diff cannot print a credential.
 *
 * Inputs, all overridable by environment variable:
 *
 * ```text
 * MEDUSA_VERIFY_BASE_URL   https://localhost:9443            the TLS terminator
 * MEDUSA_VERIFY_CA_FILE    <this dir>/tls/cert.pem           self-signed cert to trust
 * MEDUSA_VERIFY_ADMIN      admin@medusa-verify.local         admin user email
 * MEDUSA_VERIFY_ADMIN_PW   (required)                        admin password
 * ```
 *
 * `MEDUSA_VERIFY_ADMIN_PW` has no default on purpose: the password is chosen
 * when the admin user is created (harness.md step 4) and must never be written
 * into this repo.
 *
 * Usage: `MEDUSA_VERIFY_ADMIN_PW=… node mint-key.mjs`
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MEDUSA_VERIFY_BASE_URL ?? "https://localhost:9443";
const CA = process.env.MEDUSA_VERIFY_CA_FILE ?? join(HERE, "tls", "cert.pem");
const EMAIL = process.env.MEDUSA_VERIFY_ADMIN ?? "admin@medusa-verify.local";
const PASSWORD = process.env.MEDUSA_VERIFY_ADMIN_PW;

if (typeof PASSWORD !== "string" || PASSWORD.length === 0) {
  console.error(
    "MEDUSA_VERIFY_ADMIN_PW is required (the admin password chosen in harness.md step 4).",
  );
  process.exit(2);
}

const agent = new https.Agent({ ca: readFileSync(CA) });

function req(path, { method = "GET", body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(
      `${BASE}${path}`,
      {
        method,
        agent,
        headers: {
          accept: "application/json",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const login = await req("/auth/user/emailpass", {
  method: "POST",
  body: { email: EMAIL, password: PASSWORD },
});
console.log(
  "login status:",
  login.status,
  "| token returned:",
  typeof login.body?.token === "string",
);
if (typeof login.body?.token !== "string") {
  console.error("login did not return a token; body keys:", Object.keys(login.body ?? {}));
  process.exit(1);
}

const created = await req("/admin/api-keys", {
  method: "POST",
  token: login.body.token,
  body: { title: "loxep-live-verify", type: "secret" },
});
console.log("create key status:", created.status);
const key = created.body?.api_key;
if (!key || typeof key.token !== "string") {
  console.error(
    "unexpected create-key response; keys:",
    Object.keys(created.body ?? {}),
    "| type:",
    created.body?.type,
  );
  process.exit(1);
}
console.log(
  `api_key id: ${key.id} | type: ${key.type} | redacted: ${key.redacted} | token length: ${key.token.length}`,
);

const dir = join(homedir(), ".config", "loxep");
mkdirSync(dir, { recursive: true });
const file = join(dir, "medusa.env");
writeFileSync(
  file,
  [
    "# Loxep dev/test credentials for the throwaway local Medusa v2 backend",
    "# (compose project `medusa-verify`). NOT a production credential path.",
    "#",
    "# MEDUSA_CA_CERT_FILE is a LOCAL-HARNESS-ONLY extra: the adapter requires",
    "# https, and this backend is fronted by an nginx TLS terminator using a",
    "# self-signed certificate. The live tests trust that one certificate",
    "# explicitly instead of disabling verification globally.",
    `MEDUSA_URL=${BASE}`,
    `MEDUSA_RO_API_TOKEN=${key.token}`,
    `MEDUSA_CA_CERT_FILE=${CA}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
chmodSync(file, 0o600);
console.log("wrote", file, "(mode 600)");
