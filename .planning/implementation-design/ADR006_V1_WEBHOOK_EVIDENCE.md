# ADR-006 — V-1 Webhook Contract Evidence

## 1. Status

**V-1 VERIFIED FOR IMPLEMENTATION (notification envelope only).**

- Recheck date: **2026-09-28**. Only official Mercado Pago developer documentation is normative.
- **Scope:** the notification envelope: signature, topics, envelope ids and response/retry behaviour.
- **Out of scope (V-2):** payment resource fields. These are amounts, fees, taxes, payer, `external_reference`, dates, refunds, `operation_type` and status semantics. None of them was inspected or frozen here.
- **Code:** [`supabase/functions/_shared/mp-webhook-contract.ts`](../../supabase/functions/_shared/mp-webhook-contract.ts).
- **Test vectors:** [`scripts/target-db/verifySignature.test.mjs`](../../scripts/target-db/verifySignature.test.mjs).
- **Non-authoritative hint:** the legacy `netlify/functions/webhook-mercadopago.ts` was not used as evidence.

## 2. Official sources

| # | URL | Title / section |
|---|---|---|
| S1 | https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks.md | "Webhooks": configuration, topics, secret signature validation, response and retries, body attributes |
| S2 | https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/payment-notifications | "Configurar notificaciones de pago": example request, body, signature, response |
| S3 | https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/chargebacks/notifications | "Configurar notificaciones de contracargos": example body. The same page exists on `.com.mx` |

| Fact | Source | Evidence summary |
|---|---|---|
| Signature header | S1, S2 | `x-signature: ts=<ts>,v1=<hash>`. Split the content by `,`; each part is `key=value` |
| Manifest template | S1 | `id:[data.id_url];request-id:[x-request-id_header];ts:[ts_header];` |
| Where `data.id` comes from | S1 | From the notification URL **query params** |
| `data.id` case | S1 | Uppercase alphanumeric ids are converted to lowercase. Example: `ORD01JQ4S4KY8HWQ6NA5PXB65B3D3` → `ord01jq4s4ky8hwq6na5pxb65b3d3` |
| Absent components | S1 | If `data.id` or `x-request-id` is not present, it is removed from the manifest |
| Algorithm | S1 | HMAC-SHA256 hex over the manifest, keyed with the application's secret key (Your integrations panel). The result is compared with `v1` |
| `ts` | S1, S2 | "Notification timestamp (in milliseconds)". S2 example: `ts=1742505638683` (13 digits). S1 example: `ts=1704908010` (10 digits, see §4) |
| Delay tolerance | S1 | The integrator *may* use `ts` to set a delay tolerance. No window is mandated |
| Payment topic | S1, S2 | Topic "Pagos" is `payment`. Body `type:"payment"`, `action:"payment.updated"`, `data.id:"123456"` (string). URL `?data.id=123456&type=payment` |
| Chargeback topic | S1, S3 | Topic "Contracargos" is `topic_chargebacks_wh`. Body `type:"topic_chargebacks_wh"`, `actions:["changed_case_status"]`, `data.id` (JSON number), `data.payment_id` (JSON number) |
| Other topics | S1 | `merchant_order` (`topic_merchant_order_wh`), orders, claims, subscriptions and others: all **unsupported** here |
| Body `id` | S1, S2, S3 | Documented as "Notification ID". Stability across retries is **not** documented |
| Response | S1, S2 | Answer HTTP 200 or 201. MP waits 22 s |
| Retries | S1 | Every 15 min without acknowledgement. After the 3rd attempt the interval grows, but attempts continue |

## 3. Frozen signature recipe

```
header   = headers['x-signature']               // absent/empty → MISSING_SIGNATURE_HEADER
parts    = header.split(',') → trim → key=value (first '=')
           exactly one ts and one v1; no empty or duplicate part     // else MALFORMED_SIGNATURE_HEADER
           v1 must be 64 hex chars (compared lowercase)              // else MALFORMED_SIGNATURE_HEADER
ts       = 10 or 13 ASCII digits                                     // else MALFORMED_TIMESTAMP (see §4)
dataId   = single query param 'data.id' (absent/empty/repeated → absent)
reqId    = header 'x-request-id' (absent/empty → absent); never case-changed
manifest = (dataId ? "id:" + lower(dataId) + ";" : "")
         + (reqId  ? "request-id:" + reqId + ";" : "")
         + "ts:" + ts + ";"                       // ts verbatim
expected = HMAC_SHA256(secret, utf8(manifest))  // raw 32 bytes
ok       = timingSafeEqual(hexdecode(v1), expected)     // else SIGNATURE_MISMATCH
then freshness (§4)                              // STALE_TIMESTAMP / FUTURE_TIMESTAMP
```

- The raw body is **not** part of the manifest (S1).
- The secret is injected; there are no env reads in the module.
- An empty secret → `MISSING_SECRET`; a non-finite clock → `INVALID_CLOCK`.
- Reasons are fixed codes. They never contain the secret, either signature, the manifest or a prefix of any of them.
- Fixed vector:
  - secret `v1-test-secret-not-a-real-key` (a test literal);
  - manifest `id:123456;request-id:bb56a2f1-6aae-46ac-982e-9dcd3581d08e;ts:1742505638683;`
  - result `v1 = 85aaea44adced84bf23e95db43da124f818caad473052e8d0ecd46c5319c231e`.

## 4. Timestamp and freshness

- **MP rule (S1):** `ts` "can" be used to establish a delay tolerance. No value is prescribed.
- **INTERNAL_POLICY:** ±15 min (`FRESHNESS_TOLERANCE_MS = 900000`), inclusive at both ends. This is the design default in ADR006_WEBHOOK_WORKER_DESIGN_V1 §3.
- **Recorded inconsistency:** S1's text says milliseconds, but the S1 example is 10 digits (seconds) and the S2 example is 13 digits (ms).
- **INTERNAL_POLICY for the ts unit:**
  - 13 digits are read as ms;
  - 10 digits are read as seconds (×1000);
  - any other length is `MALFORMED_TIMESTAMP`.
  - The two forms are unambiguous by magnitude until the year 2286.
  - The HMAC is not affected, because it always uses `ts` verbatim.
- **Order:** authenticity is checked before freshness. A forged digest is reported as `SIGNATURE_MISMATCH` regardless of `ts`.
- **Recovery:** a rejected authentic notification is recovered by MP retries or by report back-fill (fail-closed, ADR006_WEBHOOK_WORKER_DESIGN_V1 §3).

## 5. Topic table (exact match on `type`)

| `type` | topic_class |
|---|---|
| `payment` | `payment` |
| `topic_chargebacks_wh` | `chargeback` |
| anything else, any non-string, or any case/spacing variant | `unsupported` |

`action` never changes the class.

## 6. Identity, resource id and reduced payload

- **Resource id (payment and chargeback):**
  - It is the query `data.id` (the signed component), lowercased as signed.
  - A body `data.id` given as a string, or as a safe-integer number, must match it. Otherwise → `RESOURCE_ID_MISMATCH`.
  - The chargeback body `data.id` in S3 (`233000061680860000`) exceeds `Number.MAX_SAFE_INTEGER`, so a JSON-number id is never taken from the parsed body.
  - A missing query `data.id` → `MISSING_RESOURCE_ID`.
  - Payment ids must match `^[0-9]{1,20}$`. This matches the 0047 `chk_delivery_payment_resource` constraint.
  - Chargeback ids must be **digits only**. The currently documented chargeback contract and its examples (S3: `233000061680860000`) are numeric. There is no official evidence of letters or `.`, `_`, `:`, `-` in a chargeback id, so none is accepted. The alphanumeric lowercase example in S1 belongs to another topic (orders) and is not evidence for chargebacks.
  - MP documents no maximum digit count for chargeback ids. The module caps them at 100 digits (`^[0-9]{1,100}$`). That is the internal `VARCHAR(100)` storage bound of `mp_webhook_delivery.resource_id` (0047), not a vendor guarantee.
- **Stable notification id: NONE.**
  - The body `id` is documented only as "Notification ID". Uniqueness and stability across retries are not documented.
  - So `notificationId = null`, and the DB derives the delivery key `h:<N-SHA>` (ADR006_SCHEMA_DELTA_V1 §2.1).
  - `x-request-id` is never an identity. It is kept for traceability only.
- **Chargeback → payment relation:** documented as `data.payment_id` in S3. It is recorded as envelope evidence only. Linking stays with the chargeback-signal flow (`mp_resolve_chargeback_signal`) and is not auto-applied.
- **Reduced payload allow-list:**
  - body `type`, `action`, `actions` (chargeback), `data.id`, `data.payment_id` (chargeback only), `live_mode`, `user_id`, `api_version`, `date_created`, `id`;
  - query `data.id`, `type`.
  - Unsafe JSON numbers are taken as their raw text.

## 7. Response and retries

- Respond 200 or 201 within 22 s (S1, S2).
- Unacknowledged notifications are retried every 15 min. After the 3rd attempt the interval grows, and retries continue (S1).
- The design's 200-on-duplicate, 401-on-bad-signature and 500-on-DB-error behaviour is unchanged.

## 8. Non-findings (not documented; not assumed)

- Stability or uniqueness of the body `id` across retries.
- Uniqueness of `x-request-id`, or whether it is reused on retries.
- Any duplicate-delivery or idempotency guarantee from MP.
- A mandated freshness window.
- Precedence between a query `data.id` and a body `data.id` beyond "query params" for the manifest.
- A query `data.id` example specific to chargeback notifications. The S1 general rule (query params) applies.
- A final retry horizon.

## 9. V-1 conclusion

All four blocking items are established from official documentation:

- the manifest recipe;
- payment resource id extraction;
- the payment topic mapping;
- the chargeback topic mapping.

The ts-unit ambiguity and the freshness window only affect INTERNAL_POLICY and are resolved above. There is no stable notification id, so the fallback is `h:`. Chargeback `data.payment_id` is documented.

**V-1 is verified for implementation. V-2 remains open.**
