/**
 * Seed the `medusa-verify` harness with orders that are worth asserting
 * against: three real orders placed through the Store API (cart → shipping
 * method → payment session → complete), then admin-side payment capture, a
 * PARTIAL REFUND, and a fulfillment.
 *
 * The partial refund is the point. It is what proves the single most valuable
 * finding the live stack can produce and a fixture cannot: Medusa subtracts a
 * refund from `order.total` while `original_total` stays put, which is why
 * Loxep's translator persists `originalTotal` as `orders.total_amount` and
 * never `total` (loxep-xxz design §1, mapping 1).
 *
 * Throwaway local store; obviously-fake addresses and `example.invalid`
 * buyer emails. Nothing here is real customer data.
 *
 * Inputs, all overridable by environment variable:
 *
 * ```text
 * MEDUSA_VERIFY_BASE_URL   https://localhost:9443     the TLS terminator
 * MEDUSA_VERIFY_CA_FILE    <this dir>/tls/cert.pem    self-signed cert to trust
 * MEDUSA_VERIFY_ADMIN      admin@medusa-verify.local  admin user email
 * MEDUSA_VERIFY_ADMIN_PW   (required)                 admin password
 * MEDUSA_VERIFY_DB_CONTAINER  medusa-verify-db        where the publishable key is read from
 * ```
 *
 * Usage: `MEDUSA_VERIFY_ADMIN_PW=… node seed-orders.mjs`
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MEDUSA_VERIFY_BASE_URL ?? "https://localhost:9443";
const CA = process.env.MEDUSA_VERIFY_CA_FILE ?? join(HERE, "tls", "cert.pem");
const ADMIN = process.env.MEDUSA_VERIFY_ADMIN ?? "admin@medusa-verify.local";
const ADMIN_PW = process.env.MEDUSA_VERIFY_ADMIN_PW;
const DB_CONTAINER = process.env.MEDUSA_VERIFY_DB_CONTAINER ?? "medusa-verify-db";

if (typeof ADMIN_PW !== "string" || ADMIN_PW.length === 0) {
  console.error(
    "MEDUSA_VERIFY_ADMIN_PW is required (the admin password chosen in harness.md step 4).",
  );
  process.exit(2);
}

const agent = new https.Agent({ ca: readFileSync(CA) });

// The publishable key is created by Medusa's own seed step; reading it out of
// the harness database beats making the operator copy it from the admin UI.
const PUBLISHABLE = execFileSync("docker", [
  "exec",
  DB_CONTAINER,
  "psql",
  "-U",
  "medusa",
  "-d",
  "medusa",
  "-tAc",
  "select token from api_key where type='publishable' limit 1",
])
  .toString()
  .trim();

function req(path, { method = "GET", body, token, headers = {} } = {}) {
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
          ...headers,
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
          resolve({ status: res.statusCode, body: parsed, text: data.slice(0, 400) });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const store = (path, options = {}) =>
  req(path, {
    ...options,
    headers: { "x-publishable-api-key": PUBLISHABLE, ...(options.headers ?? {}) },
  });

function must(label, res) {
  if (res.status < 200 || res.status >= 300) {
    console.error(`FAIL ${label}: status=${res.status} body=${res.text}`);
    process.exit(1);
  }
  return res.body;
}

const jwt = must(
  "admin login",
  await req("/auth/user/emailpass", {
    method: "POST",
    body: { email: ADMIN, password: ADMIN_PW },
  }),
).token;

const region = must("regions", await store("/store/regions")).regions[0];
const products = must(
  "products",
  await store(
    `/store/products?region_id=${region.id}&limit=4&fields=*variants.calculated_price`,
  ),
).products;
const variants = products.flatMap((product) =>
  product.variants.map((variant) => ({ id: variant.id })),
);
console.log(
  `region=${region.id} currency=${region.currency_code} variants=${variants.length}`,
);

const placed = [];
for (let i = 0; i < 3; i++) {
  const cart = must(
    "create cart",
    await store("/store/carts", {
      method: "POST",
      body: {
        region_id: region.id,
        email: `buyer${i + 1}@example.invalid`,
        shipping_address: {
          first_name: "Test",
          last_name: `Buyer${i + 1}`,
          address_1: `${i + 1} Verification Way`,
          city: "Copenhagen",
          country_code: "dk",
          postal_code: "1000",
        },
        items: [{ variant_id: variants[i % variants.length].id, quantity: i + 1 }],
      },
    }),
  ).cart;

  const options = must(
    "shipping options",
    await store(`/store/shipping-options?cart_id=${cart.id}`),
  ).shipping_options;
  must(
    "add shipping method",
    await store(`/store/carts/${cart.id}/shipping-methods`, {
      method: "POST",
      body: { option_id: options[0].id },
    }),
  );

  const collection = must(
    "payment collection",
    await store("/store/payment-collections", {
      method: "POST",
      body: { cart_id: cart.id },
    }),
  ).payment_collection;
  must(
    "payment session",
    await store(`/store/payment-collections/${collection.id}/payment-sessions`, {
      method: "POST",
      body: { provider_id: "pp_system_default" },
    }),
  );

  const completed = must(
    "complete cart",
    await store(`/store/carts/${cart.id}/complete`, { method: "POST" }),
  );
  if (completed.type !== "order") {
    console.error("cart did not become an order:", completed.type);
    process.exit(1);
  }
  placed.push(completed.order.id);
  console.log(
    `order ${i + 1}: ${completed.order.id} total=${completed.order.total} currency=${completed.order.currency_code}`,
  );
}

const detail = (id) =>
  req(
    `/admin/orders/${id}?fields=id,status,payment_status,fulfillment_status,total,*payment_collections.payments,*items`,
    { token: jwt },
  );

// Order 1 — captured in full.
{
  const order = must("order detail", await detail(placed[0])).order;
  const payment = order.payment_collections?.[0]?.payments?.[0];
  const captured = await req(`/admin/payments/${payment.id}/capture`, {
    method: "POST",
    token: jwt,
    body: {},
  });
  console.log("capture#1:", captured.status);
}
// Order 2 — captured, then PARTIALLY REFUNDED. This is the assertion-bearing
// order: after the refund `total` drops while `original_total` does not.
{
  const order = must("order detail", await detail(placed[1])).order;
  const payment = order.payment_collections?.[0]?.payments?.[0];
  const captured = await req(`/admin/payments/${payment.id}/capture`, {
    method: "POST",
    token: jwt,
    body: {},
  });
  console.log("capture#2:", captured.status);
  const refunded = await req(`/admin/payments/${payment.id}/refund`, {
    method: "POST",
    token: jwt,
    body: { amount: 5 },
  });
  console.log("refund#2:", refunded.status, refunded.status >= 300 ? refunded.text : "ok");
}
// Order 3 — fulfilled, so the fulfillment translation has live input.
{
  const order = must("order detail", await detail(placed[2])).order;
  const items = order.items.map((item) => ({ id: item.id, quantity: item.quantity }));
  const fulfilled = await req(`/admin/orders/${placed[2]}/fulfillments`, {
    method: "POST",
    token: jwt,
    body: { items },
  });
  console.log(
    "fulfillment#3:",
    fulfilled.status,
    fulfilled.status >= 300 ? fulfilled.text : "ok",
  );
}

for (const id of placed) {
  const order = must("final", await detail(id)).order;
  console.log(
    `final ${order.id}: status=${order.status} payment=${order.payment_status} fulfillment=${order.fulfillment_status} total=${order.total}`,
  );
}
