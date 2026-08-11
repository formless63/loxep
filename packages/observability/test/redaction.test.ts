import { describe, expect, it } from "vitest";
import { REDACT_CENSOR, SECRET_KEYS } from "../src/index.ts";
import { captureLogger } from "./helpers.ts";

describe("redaction", () => {
  it.each([...SECRET_KEYS])("redacts top-level %s", (key) => {
    const cap = captureLogger();
    cap.logger.info({ [key]: "super-secret" }, "top-level");
    expect(cap.line()[key]).toBe(REDACT_CENSOR);
  });

  it.each([...SECRET_KEYS])("redacts %s nested one level deep", (key) => {
    const cap = captureLogger();
    cap.logger.info({ connection: { [key]: "super-secret" } }, "nested-1");
    expect((cap.line().connection as Record<string, unknown>)[key]).toBe(REDACT_CENSOR);
  });

  it.each([...SECRET_KEYS])("redacts %s nested three levels deep", (key) => {
    const cap = captureLogger();
    cap.logger.info({ provider: { ebay: { credentials: { [key]: "super-secret" } } } }, "nested-3");
    const provider = cap.line().provider as Record<string, Record<string, Record<string, unknown>>>;
    expect(provider.ebay?.credentials?.[key]).toBe(REDACT_CENSOR);
  });

  it("redacts secrets inside arrays of objects", () => {
    const cap = captureLogger();
    cap.logger.info(
      {
        connections: [
          { provider: "ebay", clientSecret: "s0", token: "t0" },
          { provider: "amazon", clientSecret: "s1" },
        ],
      },
      "array",
    );
    const connections = cap.line().connections as Record<string, unknown>[];
    expect(connections[0]?.clientSecret).toBe(REDACT_CENSOR);
    expect(connections[0]?.token).toBe(REDACT_CENSOR);
    expect(connections[1]?.clientSecret).toBe(REDACT_CENSOR);
    expect(connections[0]?.provider).toBe("ebay");
  });

  it("redacts secrets nested inside objects within arrays", () => {
    const cap = captureLogger();
    cap.logger.info({ providers: [{ auth: { refreshToken: "r0", accessToken: "a0" } }] }, "deep-array");
    const providers = cap.line().providers as { auth: Record<string, unknown> }[];
    expect(providers[0]?.auth.refreshToken).toBe(REDACT_CENSOR);
    expect(providers[0]?.auth.accessToken).toBe(REDACT_CENSOR);
  });

  it("redacts encryption envelope fields", () => {
    const cap = captureLogger();
    cap.logger.info(
      { envelope: { ciphertext: "c", nonce: "n", authTag: "a", keyId: "k1" } },
      "envelope",
    );
    const envelope = cap.line().envelope as Record<string, unknown>;
    expect(envelope.ciphertext).toBe(REDACT_CENSOR);
    expect(envelope.nonce).toBe(REDACT_CENSOR);
    expect(envelope.authTag).toBe(REDACT_CENSOR);
    expect(envelope.keyId).toBe("k1");
  });

  it("redacts authorization, cookie, and set-cookie headers, including under req/res", () => {
    const cap = captureLogger();
    cap.logger.info(
      {
        headers: { authorization: "Bearer x", cookie: "sid=1", "set-cookie": "sid=1; HttpOnly" },
        req: { headers: { authorization: "Bearer y", cookie: "sid=2", host: "example.test" } },
        res: { headers: { "set-cookie": "sid=3; HttpOnly" } },
      },
      "headers",
    );
    const entry = cap.line();
    const headers = entry.headers as Record<string, unknown>;
    const req = entry.req as { headers: Record<string, unknown> };
    const res = entry.res as { headers: Record<string, unknown> };
    expect(headers.authorization).toBe(REDACT_CENSOR);
    expect(headers.cookie).toBe(REDACT_CENSOR);
    expect(headers["set-cookie"]).toBe(REDACT_CENSOR);
    expect(req.headers.authorization).toBe(REDACT_CENSOR);
    expect(req.headers.cookie).toBe(REDACT_CENSOR);
    expect(req.headers.host).toBe("example.test");
    expect(res.headers["set-cookie"]).toBe(REDACT_CENSOR);
  });

  it("leaves non-secret sibling fields and the message intact", () => {
    const cap = captureLogger();
    cap.logger.info(
      { provider: "ebay", accountId: "acct-1", config: { apiKey: "k", region: "us" } },
      "provider context",
    );
    const entry = cap.line();
    expect(entry.provider).toBe("ebay");
    expect(entry.accountId).toBe("acct-1");
    expect((entry.config as Record<string, unknown>).region).toBe("us");
    expect((entry.config as Record<string, unknown>).apiKey).toBe(REDACT_CENSOR);
    expect(entry.msg).toBe("provider context");
  });

  it("never emits the raw secret value anywhere in the serialized line", () => {
    const cap = captureLogger();
    const secret = "hunter2-raw-secret-value";
    cap.logger.info(
      {
        password: secret,
        a: { token: secret },
        b: { c: { apiKey: secret } },
        d: [{ clientSecret: secret }],
      },
      "no-leak",
    );
    expect(JSON.stringify(cap.line())).not.toContain(secret);
  });
});
