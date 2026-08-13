import { describe, expect, it } from "vitest";
import { createInvoiceNinjaAdapter, probeConnection } from "../src/index.ts";
import { TEST_BASE_URL, TEST_TOKEN, createFetchStub } from "./http.ts";
import { invalidTokenErrorBody } from "./fixtures.ts";

function makeAdapter(stub: ReturnType<typeof createFetchStub>) {
  return createInvoiceNinjaAdapter({
    baseUrl: TEST_BASE_URL,
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
  });
}

describe("probeConnection", () => {
  it("reports ok on a successful minimal /ping call, calling the cheapest documented endpoint", async () => {
    const stub = createFetchStub([
      { body: { data: { company_name: "Fixture Co", user_name: "Fixture User" } } },
    ]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(true);
    expect(result.baseUrl).toBe(TEST_BASE_URL);
    expect(result.error).toBeUndefined();
    expect(stub.pathOf(0)).toBe("/api/v1/ping");
  });

  it("returns ok: false with taxonomy 'auth' for the live-verified 'Invalid token' shape, never throwing", async () => {
    const stub = createFetchStub([{ status: 403, body: invalidTokenErrorBody() }]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("auth");
  });

  it("returns ok: false with taxonomy 'provider_unavailable' for a 5xx", async () => {
    const stub = createFetchStub([{ status: 500, body: { message: "boom" } }]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("provider_unavailable");
  });

  it("never reads the response body for company/user identifying text", async () => {
    // ok:true carries only baseUrl — company_name/user_name are structurally
    // absent from InvoiceNinjaProbeResult.
    const stub = createFetchStub([
      { body: { data: { company_name: "Real Customer Name Inc", user_name: "Real Person" } } },
    ]);
    const result = await probeConnection(makeAdapter(stub));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Real Customer Name Inc");
    expect(serialized).not.toContain("Real Person");
  });
});
