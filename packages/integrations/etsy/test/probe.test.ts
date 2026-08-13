import { describe, expect, it } from "vitest";
import { createEtsyAdapter, createRateBudget, probeConnection } from "../src/index.ts";
import { createFetchStub, TEST_KEYSTRING, TEST_SHARED_SECRET } from "./http.ts";
import { etsyErrorBody, pingResponse } from "./fixtures.ts";

function testAdapter(fetchImpl: ReturnType<typeof createFetchStub>["impl"]) {
  return createEtsyAdapter({
    keystring: TEST_KEYSTRING,
    sharedSecret: TEST_SHARED_SECRET,
    rateBudget: createRateBudget({ capacity: 10, refillPerSecond: 10 }),
    fetchImpl,
  });
}

describe("probeConnection", () => {
  it("reports ok with the application id on success", async () => {
    const stub = createFetchStub([{ status: 200, body: pingResponse }]);
    const result = await probeConnection(testAdapter(stub.impl));
    expect(result).toEqual({ ok: true, applicationId: 123456 });
  });

  it("reports ok: false with the taxonomy kind on failure, never throwing", async () => {
    const stub = createFetchStub([{ status: 401, body: etsyErrorBody("bad key") }]);
    const result = await probeConnection(testAdapter(stub.impl));
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("auth");
  });
});
