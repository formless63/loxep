import { describe, expect, it } from "vitest";
import { createReverbAdapter, createRateBudget, probeConnection } from "../src/index.ts";
import { createFailingFetchStub, createFetchStub, TEST_TOKEN } from "./http.ts";
import { pingAccountResponse, reverbErrorBody } from "./fixtures.ts";

function testAdapter(fetchImpl: ReturnType<typeof createFetchStub>["impl"]) {
  return createReverbAdapter({
    personalAccessToken: TEST_TOKEN,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 100 }),
    fetchImpl,
  });
}

describe("probeConnection", () => {
  it("reports ok: true on a successful /my/account call", async () => {
    const stub = createFetchStub([{ status: 200, body: pingAccountResponse }]);
    const adapter = testAdapter(stub.impl);
    const result = await probeConnection(adapter);
    expect(result).toEqual({ ok: true });
    expect(stub.pathOf(0)).toBe("/api/my/account");
  });

  it("reports ok: false with the normalized kind on an auth failure", async () => {
    const stub = createFetchStub([{ status: 401, body: reverbErrorBody("bad token") }]);
    const adapter = testAdapter(stub.impl);
    const result = await probeConnection(adapter);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("auth");
  });

  it("reports ok: false on a transport failure without throwing", async () => {
    const stub = createFailingFetchStub(new Error("network down"));
    const adapter = testAdapter(stub.impl);
    const result = await probeConnection(adapter);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("provider_unavailable");
  });
});
