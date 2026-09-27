# ADR-006 WEBHOOK AND WORKER DESIGN V1

**Status:** implementation design; not implemented. **Authority:** ADR-006 §6, §10 and §12; ADR006_RPC_CONTRACTS_V1 (S1–S4, 40, A1, C2, R3, R4).

---

## 1. Components

| Component | Runtime | Holds | Talks to |
|---|---|---|---|
| `mp-webhook` | Supabase Edge Function, `verify_jwt = false` (MP cannot send a Supabase JWT) | `MP_WEBHOOK_SECRET`, `MP_COLLECTOR_ID`, the service-role key (platform-injected) | MP (inbound only); DB via `mp_register_delivery` only |
| `mp-worker` | Supabase Edge Function, `verify_jwt = false`, invocation authenticated by `WORKER_INVOKE_SECRET` (header, constant-time compare) | `MP_ACCESS_TOKEN`, `MP_COLLECTOR_ID`, `WORKER_INVOKE_SECRET`, the service-role key | MP API (`GET /v1/payments/{id}` read-only); DB via S2, S3, S4, RPC 40, A1, C2 |
| Scheduler | `pg_cron` every minute → `pg_net` POST to `mp-worker`; the invoke secret is read from Supabase **Vault** | — | `mp-worker` |
| Report import | ADMIN upload in Phase 27, or a manual script until then → service-role INSERT of report rows (`csv_import` today; `account_money_csv` after V-3), then worker call to RPC 40 per row, then R3 and R4 | — | DB |

- `/api/integrations/mercadopago/webhook` on the app domain is a Netlify redirect (status 200 proxy) to `mp-webhook`. The proxy must forward the method, raw body, query string, `x-signature` and `x-request-id` unchanged.
- The worker core is a pure TypeScript module (`mpWorkerCore`) with injected `db`, `mpApi`, `clock` and `log`. It is run by Deno in production and tested with mocks (ADR006_TEST_MATRIX_V1). The same applies to `verifySignature`.

---

## 2. Webhook request handling (`mp-webhook`)

| Step | Behaviour | Result |
|---|---|---|
| 1 | Method ≠ POST → 405. Body > 64 KB → 413. Not JSON → 400. Nothing is logged except status and request id | reject; nothing stored |
| 2 | Extract only: headers `x-signature`, `x-request-id`; query `data.id`, `type` / `topic`; body `type` / `topic`, `action`, `data.id`, `live_mode`, `user_id`, `api_version`, `date_created`, `id` (plus any chargeback body field **only** if the V-1 documentation check lists it) | reduced payload |
| 3 | `verifySignature({headers, query, rawBody, secret, now})` → `{ok, reason}` (§3) | not ok → **401**; nothing stored; log `{request_id, reason}` |
| 4 | `live_mode === true` and `String(user_id) === MP_COLLECTOR_ID`; else **200** with nothing stored and log `IGNORED_FOREIGN_OR_TEST`. It returns 200 rather than 401 because the notification is authentic but not ours, and 200 stops MP retrying | — |
| 5 | `topic_class = classifyTopic(type/topic, action)` from the **V-1-verified topic table**: the documented payment topic(s) → `payment`; the documented chargeback topic(s) → `chargeback`; anything else → `unsupported`. The table is a constant in the function, filled at code time from the current official docs; nothing is guessed | topic class |
| 6 | `mp_register_delivery('webhook', topic, topic_class, action, resource_id, notification_id, x-request-id, reduced, true)`. The function passes fields only; the database computes `notification_sha256` (N-SHA) and derives the durable `delivery_key` (`'n:'…` from a documented stable notification id, else `'h:'` + canonical hash) and stores `x-request-id` for traceability only (ADR006_SCHEMA_DELTA_V1 §2.1) | DB error → **500**, so MP retries; otherwise continue |
| 7 | Respond **200** `{}` (no body details) | — |
| 8 | Best-effort kick after responding (`EdgeRuntime.waitUntil`): one POST to `mp-worker`. Its failure is ignored, because the cron guarantees progress | — |

- **Duplicate notification** (same documented notification id, or same canonical content): step 6 returns `created: false` and the response is still 200. The design does **not** assume MP reuses `x-request-id` on retries. Correctness does not depend on delivery deduplication (ADR-006 §7 layer 1).
- **Same key, different content:** stored as a separate conflict row and processed. It is never merged (§2.1 of the schema delta).
- **Chargeback notification:** stored as a `chargeback` delivery (`RECEIVED`) and processed by §4a. It is **never** `UNSUPPORTED`.
- **Unsupported topic:** stored as `UNSUPPORTED` and answered 200.
- **CORS:** none. No `Access-Control-Allow-Origin`, since the endpoint is server-to-server.

---

## 3. Signature verification boundary (V-1)

**Interface:**

```
verifySignature(input: {headers, query, rawBody, secret, now}): {ok: boolean, reason?: string}
```

**Fixed by the architecture** (V-1 VERIFIED FOR ARCHITECTURE):
- the MP `x-signature` header carries a timestamp and an HMAC-SHA256 value computed with the application's secret key;
- the value is recomputed server-side and compared in **constant time**;
- a missing header or part → `ok: false`;
- the timestamp must be within a freshness window;
- the secret is never logged, and neither is the computed or received signature, the manifest or any prefix of them.

**Rechecked at code time against the current official MP docs (V-1 recipe):**
- the topic table: the exact payment **and chargeback** notification topic / type strings, their body shape, and their resource identifiers (for a chargeback: the chargeback id, and whether a payment reference is documented in the notification);
- whether a documented, stable notification id exists per topic (it feeds the `'n:'` delivery key);
- the exact manifest template, including which parts are included and when;
- the case rules for `data.id`;
- the `ts` unit;
- the freshness tolerance (the default proposal is ±15 min);
- the response deadline;
- the retry cadence.

The recipe is encoded as test vectors in `verifySignature.test`. The legacy function's recipe (`netlify/functions/webhook-mercadopago.ts`) is a hint only, not an authority.

**Fail-closed:** any doubt means reject. A rejected authentic notification is recovered by MP's retries after the fix, or by report back-fill.

---

## 4. Worker loop (`mp-worker`)

Each invocation runs within a time budget of 50 s:

```
1. claims = mp_claim_deliveries(p_limit => 20, p_lease_seconds => 120)
   -- each row: (delivery_id, claim_token, origin, topic_class, topic, resource_id, attempts); topic_class comes from the claim, with no extra lookup
2. for each claim (sequentially; one payment at a time):
   a. topic_class = 'chargeback' → §4a (signal path) ; continue
      topic_class = 'unsupported' → mp_delivery_transition(PERMANENT, 'UNSUPPORTED_TOPIC')   [defensive; normally stored UNSUPPORTED]
   b. resp = mpApi.getPayment(resource_id)    timeout 10 s, Authorization: Bearer MP_ACCESS_TOKEN
   c. classify resp (§5):
        success       → go to d
        retryable     → mp_delivery_transition(RETRY, code, detail, retryAfter) ; continue
        permanent     → mp_delivery_transition(PERMANENT, code, detail) ; continue
        auth config   → mp_delivery_transition(CONFIG_BLOCKED, 'AUTH_CONFIGURATION_ERROR', 'http 401|403') ;
                        log.error('MP_AUTH_CONFIGURATION_ERROR', {delivery_id, http_status}) ;
                        release every remaining claim of this invocation (mp_delivery_transition(RELEASE)) ; STOP the invocation
                        [circuit breaker: the token is shared, so the rest of the batch is not attempted]
   d. boundary checks on the payload (not a DB authority):
        String(payload.collector_id) === MP_COLLECTOR_ID   else PERMANENT 'COLLECTOR_MISMATCH' (security log)
        payload.id == resource_id                          else PERMANENT 'PAYLOAD_ID_MISMATCH'
   e. src = mp_ingest_api_snapshot(delivery_id, claim_token, resource_id, payload)
   f. if src.processing_status = 'PENDING': mp_normalize_source(src.id)
   g. PENDING children (api_refund of this payment): mp_normalize_source(child) for each
   h. every movement of this payment that is auto-applicable and has no reconciliation: mp_apply_transition(movement)
        APPLIED | ALREADY_APPLIED → ok
        TRANSITION_ALREADY_ASSIGNED | APPLICATION_NET_MISMATCH | EXTERNAL_REF_CONFLICT → leave; it shows in review (view)
        PERIOD_CLOSED → leave; it shows in review; retried by the daily sweep after the ADMIN reopens the period
   i. APPROVAL newly POSTED → mp_auto_allocate(approval movement)   (a NONE result is normal)
   j. report rows parked DEFERRED_BACKFILL for this payment id → mp_normalize_source(each)   (they become MATCHED / DISCREPANCY)
   k. mp_delivery_transition(FETCHED, source_record_id = src.id)
3. Daily sweep (first invocation after 03:00 local):
     re-run h for any auto-applicable movement without reconciliation;
     re-run i for POSTED, unattributed APPROVAL movements of the last 30 days (payer maps added later);
     re-run f for PENDING api_* sources (crash leftovers)
```

### 4a. Chargeback signal path (no financial amount is taken from it)

```
1. Resolve the related payment id, using ONLY documented sources:
     (i)  a payment reference field in the notification, if the V-1 check documents one; or
     (ii) the chargeback resource, if V-2 proves a read-only chargeback endpoint and its payment-reference field
          (fetched with the same token and the same §5 classification, including CONFIG_BLOCKED for 401/403).
2. mp_delivery_transition(p_delivery_id, p_claim_token, 'SIGNAL_RECORDED', p_link_payment_id => <id matching ^[0-9]{1,20}$, or NULL>)
     an invalid id → INVALID_PAYMENT_ID; the whole transition rolls back (the row stays PROCESSING); the worker logs it and
     retries the transition with p_link_payment_id => NULL (the signal is then recorded unlinked, for ADMIN resolution)
     id known → the same transaction enqueues a 'chargeback_refresh' payment delivery (key 'cbrefresh:<signal>:<payment>')
                 and marks the signal LINKED (automatic)
     id unknown → the signal stays unresolved
```

- The **payment refresh** re-fetches the authoritative payment. If its V-2-confirmed status shows a chargeback or mediation, the derived alert (R3) keeps the payment in REVIEW_REQUIRED.
- An **unresolved signal** is REVIEW_REQUIRED in `report_mp_delivery_health.unresolved_chargeback_signals`. The ADMIN resolves it with `mp_resolve_chargeback_signal`: `LINKED` (with a payment id, which enqueues the refresh) or `DISMISSED` (with evidence that no money moved).
- **Treasury is never touched by the signal.** The financial application of a chargeback waits for an authoritative amount source in the accepted design:
  - the API, **only if V-2 proves** a chargeback amount and date source (that would need a later addendum, since this design ingests no chargeback resource as a financial source);
  - otherwise the V-3 Account Money report row → `mp_apply_transition` (MP_SETTLEMENT −amount plus OD-1).
- **Idempotency:** the signal delivery key (§2.1) deduplicates retries. The refresh key `'cbrefresh:<signal>:<payment>'` is unique, and the refresh fetch is resource-keyed (no duplicate effect).

- **Every step is idempotent** (ADR006_IDEMPOTENCY_AND_STATE_V1). A crash at any step leaves either the lease to expire (re-claim) or durable rows that the next pass recognizes.
- **Steps e–j run as separate DB calls on purpose.** Each RPC is atomic on its own, and the cross-call state is always re-derived from the tables, never from worker memory.
- **Order independence:** the worker always fetches the **current** resource, so notification order is irrelevant (ADR-006 §6.3). A stale re-delivery produces an identical snapshot (same hash), which means no new source.

---

## 5. MP API response classification and retry schedule

| Response | Class | Delivery outcome | Error code |
|---|---|---|---|
| 200 with a JSON object | success | — | — |
| 404 | transient: an eventual-read condition (the resource is not yet visible) | RETRY | `MP_NOT_FOUND` |
| 429 | transient; honor `Retry-After` | RETRY | `MP_RATE_LIMIT` |
| 500–599, timeout, network error | transient | RETRY | `MP_UNAVAILABLE` |
| 401, 403 (unauthorized, forbidden, scope) | **authentication / configuration failure**: **not** in the retry loop | **CONFIG_BLOCKED** | `AUTH_CONFIGURATION_ERROR` (detail `http 401` / `http 403`) |
| 400 or another 4xx | permanent | PERMANENT | `MP_BAD_REQUEST` |
| 200 with non-object JSON | permanent | PERMANENT | `MP_BAD_PAYLOAD` |
| collector or id mismatch | permanent (security) | PERMANENT | `COLLECTOR_MISMATCH` / `PAYLOAD_ID_MISMATCH` |

**Schedule for `next_attempt_at` after a RETRY** (transient classes only; attempt n = attempts after the claim):
- 1 min, 2 min, 4 min, 8 min, 16 min, 32 min, then every 60 min;
- `Retry-After` overrides, clamped to [60 s, 3600 s];
- **The 48 h horizon is our internal policy, not a Mercado Pago guarantee.**

**Authentication / configuration failure (401 / 403):**
- **Persisted:** the delivery becomes `CONFIG_BLOCKED`, with `last_error_code = 'AUTH_CONFIGURATION_ERROR'`. It is not discarded, and it is not marked processed. No source, movement, operation, allocation or audit row is written for it, because nothing was fetched.
- **No hot retry:** `CONFIG_BLOCKED` is **not** selected by `mp_claim_deliveries`, so it never enters the exponential or hourly loop. The circuit breaker (§4 step c) stops the rest of the invocation.
  - New deliveries arriving while the credential is still broken are each attempted **once** and join `CONFIG_BLOCKED`.
  - The 48 h horizon does not apply: `CONFIG_BLOCKED` never ages into `FAILED_PERMANENT`.
- **Operational alert:**
  - an error-level log `MP_AUTH_CONFIGURATION_ERROR` (no token, no payload);
  - `report_mp_delivery_health.auth_configuration_error = true` with a count and the oldest timestamp. The Phase 27 admin dashboard shows it as a banner;
  - axis A is REVIEW_REQUIRED for the affected payment.
- **Recovery (explicit):** after the credential or scope is corrected, `mp_requeue_config_blocked(p_reason)` is called. It is ADMIN or service role, and audited once per call. It moves every `CONFIG_BLOCKED` delivery to `RECEIVED` with `next_attempt_at = NOW()` and a cleared lease. Processing then follows the normal path, and every downstream step is idempotent, so a requeue can create no duplicate.
- **Optional recovery sweep:** at most **once per hour**, and only while `CONFIG_BLOCKED` rows exist, the worker makes **one** authenticated probe (`GET /v1/payments/{resource_id}` of the oldest blocked delivery).
  - 200 → it calls `mp_requeue_config_blocked('auto: credential probe succeeded')`.
  - 401 / 403 → nothing changes: no state change and no audit.
  - This is one request per hour, not a per-delivery retry.
- **Repeated identical 401 / 403** (for example after a requeue while the credential is still wrong) changes only `attempts`, `last_error_*` and `updated_at` on the delivery row. It creates no financial effect and no audit row.

**Dead letter:**
- `FAILED_PERMANENT` is the dead-letter state for the permanent classes, or for transient classes when `NOW() − first_failed_at > 48 h` (internal policy).
- `CONFIG_BLOCKED` is a separate **recoverable** holding state and is not a dead letter.
- Both `FAILED_PERMANENT` and `CONFIG_BLOCKED` are shown in `report_mp_delivery_health`, and they make axis A REVIEW_REQUIRED for the affected payment when one is known.
- Recovery:
  - an ADMIN re-fetch through `mp_request_refetch(payment_id, reason)` (origin `manual_refetch`, key `'refetch:' ‖ payment_id ‖ ':' ‖ uuid`);
  - or report back-fill;
  - or `mp_normalize_report_fallback` once V-4 is verified.

**Lease:** 120 s. The HTTP timeout (10 s) × 1 plus the DB calls fit well within it. An expired lease is re-claimable (S2), and the S3 token check discards the stale worker's late transition.

---

## 6. Report flow (V-3 / V-4 dependent parts marked)

1. **Ingest:** the upload inserts one `mp_source_record` per report row, with `source_type = 'csv_import'` (Liberaciones, the ADR-003 D1 layout, unchanged) or `'account_money_csv'` (**V-3 blocked**: refused until its parser is frozen). The rows are immutable (0039 guard).
2. **Normalize:** the worker calls RPC 40 per PENDING report row:
   - yield and payout → claim + movement + REPORT_ONLY (yield is then applied by A1; payout waits for the ADMIN transfer link);
   - reserve → IGNORED (ADR-003);
   - payment → `DEFERRED_V4` while V-4 is open; after V-4 → MATCHED / DISCREPANCY, or `DEFERRED_BACKFILL` plus a back-fill delivery.
3. **Coverage:** `mp_check_report_coverage(report_type, from, to)`. The coverage is the report's declared period (V-3 for Account Money; for Liberaciones, min and max `DATE` of the upload).
   - **While V-4 is open, MISSING_IN_REPORT is not computed for payment transitions**, since there is no equivalence to match on. It is computed for report-only kinds only.
4. **Balance:** `mp_record_balance_check` for the day-closing row of each day in the upload.
5. **No financial effect** is created by steps 1–4, except through claimed report-only transitions (yield / account tax / chargeback), which A1 applies exactly once.

---

## 7. Secrets and configuration

| Secret | Where | Never in |
|---|---|---|
| `MP_WEBHOOK_SECRET` | Edge Function secrets (`supabase secrets set`) | git, DB, frontend, logs |
| `MP_ACCESS_TOKEN` | Edge Function secrets (the worker only) | git, DB, frontend, logs, `mp-webhook` |
| `MP_COLLECTOR_ID` | Edge Function secrets (both functions) | frontend |
| `WORKER_INVOKE_SECRET` | Edge Function secrets plus Supabase Vault (read by the cron job) | git, migrations, logs |
| service-role key | platform-injected into functions | frontend, git |

- **Local and test:** secrets come from an untracked env file that is never committed. The test suites use fixed fake secrets and a mocked MP API; they never use real MP credentials.
- **Rotation:**
  - rotating the webhook secret causes 401s until updated, which MP retries recover;
  - rotating the token makes affected deliveries `CONFIG_BLOCKED` plus the alert, until the new token is set and `mp_requeue_config_blocked` runs (explicitly, or through the hourly probe).

---

## 8. Logging policy

- **Allowed:** request id, delivery id, resource id, status class, error code, durations, counts.
- **Forbidden:** request body, `x-signature`, manifest, HMAC (any prefix), access token, payer data (email, name, identification), and full MP payloads.
- A payload is stored only in `mp_source_record.event_data` (ADMIN-read, RLS). It is never logged.

---

## 9. What the webhook endpoint does NOT imply

- Being public gives no database privilege to anyone. The function holds the service-role key server-side and uses exactly one RPC (`mp_register_delivery`).
- `anon` gains nothing: no grant on any new table or function (ADR006_RLS_AND_SECURITY_V1).
