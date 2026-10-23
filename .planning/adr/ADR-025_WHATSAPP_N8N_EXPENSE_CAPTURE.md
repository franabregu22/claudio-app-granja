# ADR-025 — Expense and invoice capture from WhatsApp (n8n) through a delegated-confirmation gateway

**STATUS:** **PROPOSED** — option C (delegated confirmation) is **conditional** (P-1). Local proofs PASSED for the delegation
(PR-3, PR-4), least privilege (PR-7) and Meta HMAC over raw bytes (PR-9). Finding F-1 (`pg_net` open to `PUBLIC`) **cannot be
remediated with project privileges** (§17.2), so the gateway channel is re-proposed: a dedicated Supabase Auth user through
PostgREST instead of a custom LOGIN role (P-12, §17.3). **Update 2026-10-23 (§19):** the minimal staging of §18 is built and
running end to end on AppGranja (text expenses with OpenAI interpretation, corrections, confirmation, cancellation, duplicate
references); the production read-only PR-5 passed on 2026-10-21. Still **PROPOSED**: no production migration, function or
deployment exists. Production parity (B-4) passed read-only on 2026-10-23; the cutover is still blocked by the production
Meta configuration (B-1) and the live payment accounts (D-3) — §19.4–§19.6.
**DATE:** 2026-10-21 (security review and local proof of concept the same day); staging results 2026-10-22 / 23 (§19)
**AMENDS:** nothing yet. If accepted: a new `wa` schema, a dedicated LOGIN role `wa_gateway`, one Supabase Edge Function.
**NOT AFFECTED:** every accounting RPC and table (`register_casual_purchase`, `register_purchase`,
`register_purchase_with_fiscal_document`, `register_fiscal_document`, purchases, postings, ledgers, P&L, Mercado Pago
reconciliation, ADR-021 provisional outflows), the frozen rule "no RPC parameter can name a user" (0011 header), RLS of the
existing tables, the ERP frontend.

---

## 1. Context

The owner wants to send expenses and invoices from WhatsApp, review the interpretation, correct it and confirm it there;
the ERP records them only after confirmation. n8n (Railway, own PostgreSQL) already interprets a test expense.

Owner decisions:

| # | Decision | Date |
|---|---|---|
| O-1 | Two ADMIN users: the owner and his brother, each with his own WhatsApp number. | 2026-10-21 |
| O-2 | Each can create, correct, confirm and cancel **his own** drafts only. | 2026-10-21 |
| O-3 | Confirmation in WhatsApp is mandatory before anything is recorded. | 2026-10-21 |
| O-4 | In scope: expenses without invoice, purchases with invoice / receipt, VAT-only documents. | 2026-10-21 |
| O-5 | Credit purchases record the **debt**; no fictitious payment. Paying existing debts is out of scope. | 2026-10-21 |
| O-6 | Drafts expire after 48 h. | 2026-10-21 |
| O-7 | No egg production by WhatsApp. | 2026-10-21 |
| O-8 | Delegated confirmation accepted as a **design candidate**, not yet approved for implementation. | 2026-10-21 (review) |
| O-9 | `service_role` allowed only inside a tightly scoped Supabase Edge Function; never in n8n. | 2026-10-21 (review) |
| O-10 | `WAITING_MP` drafts expire after 72 h and do **not** block a new draft of the same sender. | 2026-10-21 (review) |
| O-11 | VAT-only receipts: the private object is referenced from `wa.confirmation`; the fiscal model is not changed. | 2026-10-21 (review) |
| O-12 | n8n execution logs: at most 7 days, no attachments, no sensitive message content. | 2026-10-21 (review) |
| O-13 | (P-7) Entry point: **Meta → Supabase Edge Function → n8n**; the gateway receives the original webhook and verifies it before forwarding anything. | 2026-10-21 (proof plan) |
| O-14 | (P-8) At most 5 `WAITING_MP` drafts per sender; 72 h expiry; `WAITING_MP` does not block a new `DRAFT`. | 2026-10-21 (proof plan) |
| O-15 | (P-9) Meta's HMAC is verified by the trusted gateway over the original body with a protected secret — implemented as `wa.ingest` (database side, secret in Vault); the Edge Function and n8n never hold the app secret. | 2026-10-21 (proof plan) |
| O-16 | (P-1) Option C stays **conditional** until the §15 proofs pass. | 2026-10-21 (proof plan) |
| O-17 | (P-2) Two ADMIN profiles (owner, brother); the phone mappings are configured securely later. | 2026-10-21 (proof plan) |
| O-18 | (P-10) Investigating / testing the revocation of `PUBLIC` on `pg_net` is approved **for staging only**; production `pg_net` / `pg_cron` permissions are not changed. | 2026-10-21 (staging prep) |
| O-19 | (P-11) A permanent verification that no application-accessible SECURITY DEFINER function is executable by `PUBLIC`; frozen migrations are not modified. | 2026-10-21 (staging prep) |
| O-20 | (P-9 clarified) Meta → Supabase Edge Function → `wa.ingest` → n8n; `wa.ingest` verifies Meta's signature over the original request bytes with a secret stored in Vault. | 2026-10-21 (staging prep) |

Existing building blocks (verified read-only, 2026-10-20 / 21):

- `register_casual_purchase` — [0093:375](../../supabase/target-migrations/0093_mp_immediate_outflow_effect.sql):
  ADMIN; idempotent by `p_idempotency_key` (advisory lock + replay, `DUPLICATE_PURCHASE` on a different payload); optional
  invoice via `p_fiscal` (issuer CUIT); **paid from Mercado Pago requires `p_mp_source_id`** (`MP_SOURCE_REQUIRED`) and checks
  amount / date against the real outflow, then releases the ADR-021 provisional in the same transaction.
- `register_purchase` — [0061:18](../../supabase/target-migrations/0061_optional_purchase_attachments.sql) (supplier debt;
  `idempotency_key` UNIQUE; supplier invoice number unique per supplier).
- `register_purchase_with_fiscal_document` — [0068:24](../../supabase/target-migrations/0068_purchase_fiscal_and_fiscal_report.sql).
- `register_fiscal_document` — [0098:13](../../supabase/target-migrations/0098_fiscal_document_issuer.sql) (VAT credit, no money;
  unique issuer CUIT + number, [0088:57](../../supabase/target-migrations/0088_optional_supplier_casual_purchases.sql)).
- All are SECURITY DEFINER (owner `postgres`), `EXECUTE` for `authenticated` only, require `current_app_role() = 'ADMIN'`
  ([0006:15](../../supabase/target-migrations/0006_functions.sql)) and take the actor from `auth.uid()`; category selectability
  ([0096:139](../../supabase/target-migrations/0096_expense_category_groups.sql)), strict parent (0099) and `assert_period_open` apply.
- Private bucket `purchase-attachments` ([0058:26](../../supabase/target-migrations/0058_purchase_attachment_storage.sql)):
  10 MB, PDF / JPEG / PNG / WEBP, ADMIN-only policies.

## 2. Problem: who is the actor?

The accounting RPCs authorize and audit **`auth.uid()`**. A WhatsApp message has no Supabase session.

| Option | How | Verdict |
|---|---|---|
| A. n8n holds a user session / password, or `service_role` | n8n calls the RPCs as the user | **Rejected** (O-9; a leak = full ADMIN). `service_role` has no `auth.uid()` → `FORBIDDEN`. |
| B. Generic impersonation (`act_as(user, sql)` with `set_config`) | any caller sets any user's claims | **Rejected** — §14.2. |
| C. **Delegated confirmation function** | one narrow SECURITY DEFINER function, executable only by `wa_gateway`, establishes the actor **only** for the owner of a draft proven by Meta-signed messages, only for the four whitelisted RPCs, only inside its own transaction | **Design candidate** (O-8); viable **if** the proofs of §15 pass. |
| D. Explicit-actor core functions | split each RPC into `core(p_actor, …)` + thin `auth.uid()` wrapper | Not now — §14.6; fallback if C fails a proof. |

## 3. Proposed architecture (revised by the security review)

```
WhatsApp Cloud API ──webhook (X-Hub-Signature-256)──► Edge Function wa-gateway  ◄── entry point (O-13)
                                                        │ 1. stores the RAW body (base64) + header, untouched
                                                        │ 2. downloads media immediately → private Storage (service_role, Storage only)
                                                        │ 3. DB as role wa_gateway: wa.ingest(raw_b64, signature) — the DATABASE verifies
                                                        │    Meta's HMAC with the app secret held in Vault (§14.8)
                                                        │ 4. asks n8n to interpret (HMAC-signed request: text / media ref only)
                                                        ▼
                                  n8n (Railway): interprets, proposes a payload, formats and sends WhatsApp replies
                                                        │ proposal back to wa-gateway (HMAC + timestamp + nonce)
                                                        ▼
                     schema wa (wa_gateway EXECUTE only) ──► wa.confirm_draft ── delegated actor (§14.3) ──► the 4 RPCs
```

- **n8n is untrusted for identity and amounts**: it never receives the Meta app secret, the `wa_gateway` password or
  `service_role`; it proposes, and the database re-validates every field.
- **Sender identity is proven by the database**, not by n8n and not by the Edge Function: `wa.ingest` recomputes Meta's
  HMAC-SHA256 over the exact raw body with the app secret read from Vault inside a SECURITY DEFINER function.
- The original order (WhatsApp → n8n → gateway) was rejected (O-13); n8n never receives the raw webhook or its signature.

## 4. Data model (schema `wa`, no financial effect)

### 4.1 Tables

- `wa.sender` — `phone_e164` UNIQUE, `perfil_id` → `perfiles` UNIQUE, `activo`, `created_by`, `created_at`. Seeded by an
  ADMIN (O-1: two rows). Re-checked at every step: `activo` AND `perfiles.activo` AND `rol_type = 'ADMIN'`.
- `wa.inbound_message` — `wa_message_id` UNIQUE (Meta `wamid`), `phone_e164`, `meta_timestamp`, `received_at`, `kind`
  (text / image / document / interactive), `raw_sha256`, `signature_ok`, `interactive_payload`, `media_sha256`,
  `draft_id`, `outcome`. Message text kept only as needed for the draft.
- `wa.draft` — `id`, `short_code` (e.g. `W-0042`, shown to the user), `owner_perfil_id`, `type` (`CASUAL_EXPENSE` |
  `CASUAL_WITH_INVOICE` | `SUPPLIER_CREDIT_PURCHASE` | `SUPPLIER_PURCHASE_WITH_INVOICE` | `VAT_ONLY_DOCUMENT`), `state`,
  `version`, `payload` jsonb (exactly the target RPC's arguments), `payload_sha256`, `attachments` jsonb, `expires_at`,
  `result` jsonb, `error_code`, timestamps.
- `wa.draft_version` — append-only: `draft_id`, `version`, `payload`, `changed_by_message_id`, `created_at`.
- `wa.confirmation` — `draft_id` UNIQUE, `version`, `perfil_id`, `confirm_message_id` → `wa.inbound_message`,
  `payload_sha256`, `idempotency_key`, `receipt_object` (O-11), `confirmed_at`, `result`.

RLS on every `wa` table: ADMIN `SELECT` only (a future ERP screen); no `INSERT` / `UPDATE` / `DELETE` for any API role;
`wa_gateway` has **no table privilege** — only `EXECUTE` on the `wa` functions.

### 4.2 States and the open-draft rule (resolves O-6 / O-10)

`DRAFT` → (correction: `version + 1`) → `CONFIRMING` → `CONFIRMED`; `DRAFT` → `CANCELLED`; `DRAFT` → `EXPIRED` (48 h);
`CONFIRMING` → `FAILED` (RPC error; correctable → `DRAFT`, `version + 1`); `DRAFT` → `WAITING_MP` (paid by Mercado Pago,
outflow not yet in the release report) → `DRAFT` (an outflow is linked) or `EXPIRED` (72 h, O-10).

- **One editable draft per sender**: partial UNIQUE index on `owner_perfil_id` WHERE `state IN ('DRAFT', 'CONFIRMING')`.
- **`WAITING_MP` does not count** (O-10). A sender may have several `WAITING_MP` drafts (cap: 5, P-8).
- **Routing**: free text and media always apply to the sender's single `DRAFT` (or open one). A `WAITING_MP` draft is
  addressed only through **interactive buttons** whose payload carries `draft_id` + `version` (Meta signs it as part of the
  body), or by its `short_code`. When an MP outflow appears, the reply offers the candidates as buttons for that draft only.
  Linking returns the draft to `DRAFT`; if another `DRAFT` of the same sender is already open, the linked one waits as
  `WAITING_MP` with the candidate stored until the editable slot is free (no silent switch of context).

### 4.3 Functions (EXECUTE: `wa_gateway` only; SECURITY DEFINER owned by `postgres`; `search_path` fixed)

`wa.ingest(raw_b64, signature)` · `wa.propose(inbound_id, type, payload)` · `wa.correct(inbound_id, draft_id, expected_version, payload)`
· `wa.cancel(inbound_id, draft_id, expected_version)` · `wa.link_mp_outflow(inbound_id, draft_id, expected_version, source_id)`
· `wa.confirm_draft(inbound_id, draft_id, expected_version)` · `wa.expire_drafts()` (pg_cron).
Every action function takes the **id of a signature-verified inbound message**, never a phone or a user; the sender is
derived from that message; acting on a draft whose `owner_perfil_id` differs is refused (O-2).

## 5. Idempotency, duplicates and concurrency

| Case | Control |
|---|---|
| Meta / n8n retries the same webhook | `wa.inbound_message.wa_message_id` UNIQUE → same outcome, no new draft / version. |
| Double "SÍ" | `wa.confirm_draft` locks the draft (`FOR UPDATE`); compare-and-set `DRAFT@v` → `CONFIRMING`; a second call sees `CONFIRMED` and returns the stored `result`. `wa.confirmation.draft_id` UNIQUE. One inbound message can confirm at most one draft. |
| Crash between the accounting write and the reply | `idempotency_key = 'WA:<draft_id>:v<version>'` (≤ 100 chars; never `RECTIFY:`) → replay, never duplicate. One DB transaction. |
| Stale proposal | `expected_version` ≠ current → `WA_VERSION_CHANGED`, the current proposal is re-sent. |
| Correction racing confirmation | Same row lock: first commit wins, the other gets `WA_VERSION_CHANGED` / `WA_ALREADY_CONFIRMED`. |
| Confirmation older than the proposal | the confirm message's Meta timestamp must be later than the version's creation; a confirm message replayed later is a duplicate `wamid`. |
| Same expense twice (app + WhatsApp, two drafts) | Warning before "¿Confirmás?": same account, amount, date ±2 days; same invoice (issuer CUIT + number, also DB-enforced); same media SHA-256. Requires an explicit "SÍ, es otro". |

## 6. Bank and Mercado Pago outflows

- **Mercado Pago**: the real outflow already exists as an ADR-021 provisional (`fin_mp_pending_classification`). A WhatsApp
  expense paid by MP is **never** a new outflow: it is linked to that `SOURCE_ID` (`register_casual_purchase(... p_mp_source_id)`),
  which the database already enforces (`MP_SOURCE_REQUIRED`, `ALREADY_CLASSIFIED`, amount / date match). Until the release
  report arrives the draft is `WAITING_MP` (72 h, O-10).
- **Bank (BNA, Patagonia)**: the purchase posts on the account; the statement line is later matched 1:1 with
  `fin_match_statement_line` ([0077:23](../../supabase/target-migrations/0077_fin_statement_cutover_match_guard.sql)); the
  import creates no outflow. Residual risk (same expense entered twice) = the §5 warning.
- **Cash**: the §5 warning only.
- **Credit purchases (O-5)**: supplier debt only; the confirmation text says "queda como deuda con <proveedor>".

## 7. Original receipts

- Existing private bucket `purchase-attachments`, path `wa/<draft_id>/<sha256>.<ext>`, written at ingestion (Meta media
  URLs expire). Bucket MIME / size limits apply.
- Confirmed purchases: `p_attachments` → `purchase_attachment`. VAT-only documents: `wa.confirmation.receipt_object` (O-11).
- Cancelled / expired drafts: objects removed by the expiry job after a grace period.

## 8. Minimum data per type

| Type | RPC | Required |
|---|---|---|
| Expense without invoice | `register_casual_purchase` | date, total (= net), selectable subcategory, nature (default, editable), concept (1–100), paying account + method (cash / transfer / MP); MP → linked `SOURCE_ID`. Optional: counterparty (≤ 120), receipt. |
| Purchase with invoice, no registered supplier | `register_casual_purchase` + `p_fiscal` | the above + document type, number (POS + number), issuer CUIT (11 digits) and name, document date, fiscal period, net, total, VAT components. |
| Credit purchase, registered supplier | `register_purchase` | supplier (exact match or explicit choice), date, net, total, subcategory, nature, lines, supplier invoice number. |
| Credit purchase with invoice, registered supplier | `register_purchase_with_fiscal_document` | the above + the fiscal document fields. |
| VAT-only document | `register_fiscal_document` | type, issuer CUIT or supplier, number, date, period, net, total, components. |

## 9. Errors, retries and expiry

- Accounting errors (`CATEGORY_NOT_SELECTABLE`, `PERIOD_CLOSED`, `MP_AMOUNT_MISMATCH`, `DUPLICATE_PURCHASE`, …) → draft `FAILED`
  with the code; a plain Spanish message; correct (new version) or cancel.
- Gateway / network errors: retries carry the same `wa_message_id`; everything is idempotent (§5).
- Expiry: `wa.expire_drafts()` every 15 min (pg_cron): `DRAFT` 48 h, `WAITING_MP` 72 h → `EXPIRED`, one notification.

## 10. Tests

The full list is §16 (it supersedes the first draft's list).

## 11. Phases

1. **Proof (local, then staging)** — §15 proofs; result recorded in this ADR. **Only if all pass** may the owner move the
   ADR to ACCEPTED.
2. **Implementation (local only)** — migration (`wa` schema, role, functions), Edge Function, §16 tests. No production write.
3. **Staging** — WhatsApp test number, separate Supabase project / branch, end-to-end with fake data.
4. **Production deploy (owner gate)** — read-only precheck → migration → profile → role password and Vault secret set by
   the owner privately → Edge Function deploy → seed `wa.sender` (two phones) → n8n credentials → smoke with one real
   low-value expense and its cancellation.
5. **Pilot** — two weeks with daily review of `wa.draft` / `wa.confirmation` vs purchases.

## 12. Pending owner decisions

| # | Decision | Recommendation |
|---|---|---|
| P-1 | Approve option C for implementation | Only after PR-1, PR-2, PR-5 pass on staging / read-only production and F-1 is mitigated (§15). |
| P-12 | Gateway channel: a dedicated **Supabase Auth user** (no `perfiles` row) calling the `wa` functions **through PostgREST**, instead of a custom LOGIN role through the pooler (§17.3) | Yes — F-1 cannot be fixed with project privileges; PostgREST never exposes `net`. |
| P-13 | Staging host: a free separate Supabase project (if a free slot exists) vs. Supabase Branching (paid) (§17.6) | Free separate project. |

(P-10 → O-18, outcome §17.2; P-11 → O-19, implemented as profile check Q, §17.4.)

(Former P-2 → O-17, P-3 → O-9, P-4 → O-10, P-5 → O-11, P-6 → O-12, P-7 → O-13, P-8 → O-14, P-9 → O-15.)

## 13. Risks (summary; details in §14)

Delegation path misuse · project-wide Edge secrets · `service_role` readable Vault · pooler behaviour of a custom role ·
raw-body fidelity · LLM misinterpretation (never auto-confirm) · wrong supplier by name · cross-channel duplicates ·
Railway / n8n availability (drafts are durable in the ERP).

---

## 14. Security review (2026-10-21)

Facts were read from the **local** Supabase stack (PostgreSQL 17.6, same image family as production); each production
fact is a proof item of §15, not an assumption.

### 14.1 Verified facts

| Fact | Evidence (local) | Consequence |
|---|---|---|
| `auth.uid()` = `coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (request.jwt.claims)::jsonb ->> 'sub')` | `pg_get_functiondef('auth.uid')` | `claim.sub` wins over `claims`: a delegation must set **both** consistently (or `claim.sub` to '' and `claims`). |
| `current_app_role()` is SECURITY DEFINER, reads only `auth.uid()` → `perfiles` (`activo`) | 0006 | The ADMIN identity is exactly "a `perfiles` row with that id, active, `rol_type`". |
| The four RPCs, `fiscal_document_insert`, `mp_pending_outflow_release`, `mp_outflow_resolve`, `assert_period_open`, the category triggers and every trigger on purchases / postings / ledgers / fiscal documents / attachments / MP reconciliation read **no** `auth.role()`, `auth.jwt()` or `request.jwt.*` other than through `auth.uid()` | `prosrc` scan | Setting `sub` is sufficient; the `role` claim does not change their behaviour. |
| `set_config` is executable by PUBLIC | `pg_proc.proacl` NULL | **Any** LOGIN role can forge claims in its own session. A new role is only safe if nothing trusting `auth.uid()` is executable by it. |
| SECURITY DEFINER functions in `public` executable by PUBLIC: **0** (188 INVOKER functions are) | `aclexplode` | A role with no grants reaches no definer through PUBLIC; INVOKER functions run with its (empty) table privileges. Must be re-proven in production (it has 95 definers, local 94). |
| Default privileges of `postgres` / `supabase_admin` grant `EXECUTE` on **new** functions to `anon`, `authenticated`, `service_role` | `pg_default_acl` | Every `wa.*` function must `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` explicitly (the 0069 lesson) and `GRANT` to `wa_gateway` only. |
| `postgres` has `CREATEROLE` (not superuser), `BYPASSRLS` | `pg_roles` | Creating `wa_gateway` is technically possible; must be proven on the hosted project. |
| `service_role` cannot `INSERT` / `UPDATE` purchases, postings, operations, ledgers, fiscal documents, attachments, audit events; cannot `EXECUTE` the four RPCs | `has_table_privilege` / `has_function_privilege` | **Today `service_role` cannot create an accounting fact as an ADMIN.** Granting delegated confirmation to `service_role` would be a real privilege **increase**. |
| `service_role` can read `vault.decrypted_secrets` | `has_table_privilege` | Vault does **not** hide a secret from `service_role`. |
| Supabase injects `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` into **every** Edge Function; Edge secrets are project-wide | Supabase platform behaviour (to be confirmed for this project, PR-5) | The trust root already includes every Edge Function's code; the design limits the blast radius of **leaked credentials**, not of malicious function code. |
| `pgcrypto` (schema `extensions`), `supabase_vault`, `pg_cron`, `pg_net` installed | `pg_extension` | HMAC verification and expiry jobs are possible in the database. |

### 14.2 Why generic impersonation (option B) is rejected

`set_config` is PUBLIC and `auth.uid()` trusts it: any callable path that sets claims is an impersonation primitive for
every function and RLS policy that trusts `auth.uid()`. Session-scope settings leak through a pooler; mismatched
`claim.sub` / `claims` give an unintended identity; a generic `act_as` cannot be audited as a distinct channel.

### 14.3 Constraints on the delegation inside `wa.confirm_draft` (option C)

1. Claims set **transaction-local** (`is_local = true`), **both** `request.jwt.claim.sub` and `request.jwt.claims`
   (`{"sub": owner, "role": "authenticated"}`), previous values saved and restored before returning; on error the
   transaction (or subtransaction) rollback reverts them.
2. Immediately after setting: assert `auth.uid() = draft.owner_perfil_id` and `current_app_role() = 'ADMIN'`.
3. The actor is **read from the draft row**, never from a parameter; any claims already present in the caller's session are
   ignored and overwritten.
4. Static dispatch only: four literal calls chosen by `draft.type`; arguments mapped field by field from the typed payload;
   no dynamic SQL, no function name from data.
5. Preconditions before any claim is set: the confirming inbound message is signature-verified, from the draft owner's
   phone, interactive payload = this `draft_id` + `version`, Meta timestamp after the version, not yet used; draft `DRAFT`,
   version matches, not expired; sender mapping and profile active and ADMIN.
6. Evidence in the same transaction: `wa.confirmation` row + `audit_events` `WA_CONFIRM` (channel `WHATSAPP`, phone hash,
   draft, version, payload hash, inbound message id). The accounting rows themselves carry the human as `created_by` /
   `performed_by`.
7. The function never calls `set_config(…, false)`.

### 14.4 Dedicated role `wa_gateway` (A, C)

- `CREATE ROLE wa_gateway LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 3`; member of **no** role;
  `USAGE` on schema `wa` only; **no** table privilege anywhere; `EXECUTE` on the `wa.*` functions only; password set by the
  owner privately, stored as an Edge secret.
- Its power, given 0 PUBLIC-executable definers: the `wa.*` functions, nothing else. Forging its own claims gives it
  nothing, because nothing it can execute trusts `auth.uid()` except `wa.confirm_draft`, which overwrites them.
- **Not** granted to `service_role`: a leaked service-role key (or another Edge Function, e.g. the MP worker) still cannot
  confirm drafts — no privilege increase for `service_role` (§14.1).
- Connection: through the Supabase pooler in **session mode**, or transaction mode with one function call per
  transaction and no session state (claims are transaction-local, so a pooled backend never carries them to the next
  client). Whether the hosted pooler accepts a custom LOGIN role (`wa_gateway.<project_ref>`), and how the Edge runtime
  reaches it, is unproven → PR-1 / PR-2.

### 14.5 Concurrent confirmations by the two ADMINs (E)

Separate transactions on separate backends: transaction-local claims are per backend and per transaction, so the actor of
one confirmation can never be observed by the other. Different drafts → different row locks and different idempotency keys.
Shared resources are protected by the database, not by `wa`: the same Mercado Pago `SOURCE_ID` linked by both → the second
gets `ALREADY_CLASSIFIED` (classification / provisional-resolution uniqueness); the same invoice → the fiscal unique index;
the same period → `assert_period_open`. To be proven by PR-4.

### 14.6 Explicit-actor core functions (option D, F)

Safer in principle (no claims at all), but it means re-creating the four frozen RPCs (and their helpers) as
`core(p_actor, …)` + wrappers: large surface, risk of drift from verified bodies, changes the POST profile body
fingerprints, and contradicts "no RPC parameter can name a user" (needs its own ADR). Because the RPC bodies read
`auth.uid()` once into `v_uid` and nothing reads other claims (§14.1), option C reaches the same identity with no change to
accounting code. Option D remains the fallback if any §15 proof fails.

### 14.7 Least-privilege Edge Function (G)

- One function `wa-gateway`; three credentials, each used by one module only: the `wa_gateway` DB password (all database
  calls), `service_role` (only a Storage client restricted in code to bucket `purchase-attachments`, prefix `wa/`, upload
  and delete), the WhatsApp media token (download only).
- No `SUPABASE_DB_URL` usage; no PostgREST calls with `service_role`; no generic proxy endpoint; request bodies size-capped;
  rate limit per phone; logs without message text, amounts, tokens or phone numbers (hash only).
- n8n ↔ gateway: HMAC over body + timestamp + nonce (5-minute window, nonce stored), separate secrets per direction.

### 14.8 Meta signature (H)

- Meta signs the raw request body with the **app secret** (`X-Hub-Signature-256: sha256=<hex>`). Verification:
  `wa.ingest` decodes the base64 raw body, computes `encode(extensions.hmac(raw_bytes, app_secret, 'sha256'), 'hex')`
  and compares in constant time with the header; the app secret is read from Vault inside the SECURITY DEFINER function
  (`wa_gateway` has no Vault access).
- The app secret is never given to n8n (O-9) nor to the Edge Function's environment (O-15).
- Limit: `service_role` can read Vault (§14.1), so this protects against a leaked n8n or `wa_gateway` credential, not
  against a leaked `service_role` key; the latter is already a full-project compromise.
- The webhook verify token (GET `hub.challenge`) is a different, low-value secret held by the entry point.
- Replay: `wamid` UNIQUE + Meta timestamp window (e.g. 24 h, aligned with Meta's retry policy).

### 14.9 Could the gateway run an unauthorized RPC or impersonate another ADMIN? (D)

- Unauthorized RPC: no — `EXECUTE` only on `wa.*`; 0 PUBLIC-executable definers; static dispatch.
- Impersonating the other ADMIN: only with a **genuine Meta-signed message from that ADMIN's phone** that was never
  ingested before. A leaked `wa_gateway` password alone cannot create one (no app secret); a leaked n8n cannot either.
- Impersonating a non-mapped ADMIN: no — the actor comes only from `wa.sender` rows (seeded by an ADMIN, not writable by
  `wa_gateway`).

## 15. Proofs (status after the local proof of concept, 2026-10-21)

| # | Proof | Where | Status |
|---|---|---|---|
| PR-1 | `CREATE ROLE wa_gateway LOGIN …` by `postgres`; login with password; then through the **hosted** Supabase pooler (session + transaction mode, `wa_gateway.<project_ref>` username form) | local ✔ / staging | **Local PASS** (direct TCP login, `session_user = wa_gateway`). Hosted pooler: **OPEN** (no pooler in the local stack). |
| PR-2 | The Edge runtime reaches the database with that role (driver, TLS, IPv4/IPv6, no prepared-statement issue in transaction mode) | staging | **OPEN** |
| PR-3 | Delegated identity inside `confirm_draft` | local | **PASS** — §15.2 |
| PR-4 | Two ADMINs confirming at the same time; same draft twice | local | **PASS** — §15.2 (same `SOURCE_ID` race: implementation test, needs MP fixtures) |
| PR-5 | Production facts, read-only (§15.4) | production, READ-ONLY | **OPEN** |
| PR-6 | n8n byte-exact forwarding | — | **Not needed** (O-13: Meta → Edge Function) |
| PR-7 | Least privilege of a real `wa_gateway` login session | local | **PASS with finding F-1** — §15.2 |
| PR-8 | F-1 mitigation keeps `pg_net` / `pg_cron` working and denies `wa_gateway` | staging | **OPEN** |

### 15.1 Proof-of-concept scope (what was built, where, and removed)

Local Supabase stack only (no production data, no production credential). Disposable objects: role `wa_gateway`
(`NOINHERIT NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 3`, no membership, `USAGE` on the POC schema only), schema
`wa_poc` with one `draft` table (no grant to `wa_gateway`) and the prototype `confirm_draft` (SECURITY DEFINER, owner
`postgres`, `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`, `GRANT EXECUTE TO wa_gateway`) implementing §14.3
and calling the **unchanged** `register_casual_purchase`; three test profiles (ADMIN A, ADMIN B, OPERATOR) and four drafts.
Every accounting call ran in a transaction that was **rolled back**. Afterwards role, schema, profiles and the local
password file were removed and verified absent (0 role, 0 schema, 0 profiles, 0 purchases, 0 audit rows, 0 queued
`pg_net` requests). Scripts and outputs: session scratchpad `wa-poc/` (not part of the repository).

Testing lesson: `SET ROLE wa_gateway` from a `postgres` session is **not** a valid least-privilege test — `SET ROLE` and
`CREATE ROLE` permissions are checked against the session user, so such a session can switch back to any role. All PR-7
results below come from a real login session (`session_user = wa_gateway`).

### 15.2 Results

| Check (real `wa_gateway` login session) | Result |
|---|---|
| `SET ROLE authenticated` / `service_role` / `postgres`, `SET SESSION AUTHORIZATION postgres` | denied |
| `CREATE ROLE`, `GRANT authenticated TO wa_gateway`, `CREATE FUNCTION` in `public`, `CREATE SCHEMA` | denied |
| `SELECT` purchases / perfiles; `INSERT` financial_posting; read `vault.decrypted_secrets`, `cron.job`, `storage.objects`; write the draft table directly | denied |
| `current_app_role()`, `register_casual_purchase`, `register_purchase`, `register_fiscal_document`, `deliver_order` — also after forging both claims as ADMIN | denied (`EXECUTE`) |
| SECURITY DEFINER functions executable by `wa_gateway` in **any** schema except the POC | **0** |
| Tables reachable through `PUBLIC` grants | 6: `extensions.pg_stat_statements(_info)` (schema not usable → unreachable), `cron.job`, `cron.job_run_details` (schema not usable → unreachable), **`net.http_request_queue` (INSERT/UPDATE/DELETE) and `net._http_response` (SELECT) — reachable** → **F-1** |
| PR-3: caller pre-forged ADMIN B's claims, confirmed A's draft | `auth.uid()` inside = A; `current_app_role()` = ADMIN; `purchases.created_by` = A; `audit_events.performed_by` = A; caller's claims after return = B (restored, never left as A) |
| PR-3: replay of the same draft / stale version / OPERATOR owner / error inside the RPC (inactive reserved category) | stored result returned (`replay`); `WA_VERSION_CHANGED`; `WA_OWNER_NOT_ADMIN` before any claim is set; RPC error and caller's claims restored after the savepoint rollback |
| PR-3: two confirmations (A then B) in one session | each actor correct; caller's values unchanged at the end; after `ROLLBACK` the claims are empty |
| PR-4: A (holding its delegated identity 3 s) and B overlapping in two sessions, each caller forging the **other** admin | A's purchase / audit = A, B's = B; no cross-over |
| PR-4: same draft confirmed by two sessions at once | the second waited on the row lock (~2.2 s) until the first ended — serialized, never parallel |
| Residue after the run | 0 purchases, 0 audit rows, 0 queued HTTP requests, drafts untouched |

**Answer to the security question (requirement 5)**: `wa_gateway` can set any transaction-local claim (`set_config` is
`PUBLIC`), but it gains nothing from it: no function it can execute trusts `auth.uid()` except the delegation, which
overwrites the claims with the draft owner and restores the caller's values. This holds **only while** two invariants
hold: (F-2) no SECURITY DEFINER function is executable by `PUBLIC`, and (F-1) `wa_gateway` reaches no other privileged
surface.

### 15.3 Findings

- **F-1 (must fix before any custom LOGIN role exists in production)** — `pg_net` grants `USAGE` on schema `net` and DML on
  `net.http_request_queue` / `net._http_response` to `PUBLIC`. Any LOGIN role, including `wa_gateway`, can queue
  arbitrary outbound HTTP requests from the database host (server-side request forgery / data exfiltration) and read the
  stored responses of other jobs. Not reachable today by `anon` / `authenticated` through PostgREST (schema `net` is not
  exposed), but reachable by a direct login. Mitigation: P-10, proven by PR-8.
- **F-2 (invariant to enforce)** — the safety of a role that can forge claims rests on "0 SECURITY DEFINER functions
  executable by `PUBLIC`". It holds today only because every migration revokes `PUBLIC` explicitly (functions get `PUBLIC`
  `EXECUTE` by default). Mitigation: P-11.
- **F-3** — the hosted pooler behaviour for a custom role is unknown until PR-1 runs on staging.

### 15.4 Staging-only execution plan (no production write, no production credential)

Environment: a **separate** Supabase project (or a Supabase branch) with no production data, migrations 0001–0100 applied
from the repository, synthetic fixtures only, its own Meta test app / test number (only needed for the later end-to-end
phase, not for these proofs). Every step below runs there.

| Step | Action | PASS | FAIL |
|---|---|---|---|
| S-1 | Create `wa_gateway` exactly as §15.1 with a generated password stored as a staging Edge secret | role exists, attributes as specified, 0 memberships | any attribute differs or creation is refused |
| S-2 (PR-1) | Log in as `wa_gateway` through the pooler, session mode then transaction mode (documented username form) | both log in; `session_user = wa_gateway` | refused in both modes → fallback decision (P-1) |
| S-3 (PR-2) | A minimal Edge Function connects as `wa_gateway` (no `SUPABASE_DB_URL`, no `service_role`) and runs `SELECT session_user` and one prototype `confirm_draft` inside a rolled-back transaction | connection works; result as PR-3 | cannot connect, TLS / IPv6 / prepared-statement failure without a supported workaround |
| S-4 (PR-7 replay) | Re-run the login-session probes of §15.2 through the pooler | identical to §15.2 (except F-1 before S-5) | any additional privilege |
| S-5 (PR-8, P-10) | Revoke `PUBLIC` on schema `net` and its tables; re-grant the roles that run `pg_net` / `pg_cron` jobs; run a scheduled HTTP job | job still succeeds; `wa_gateway` gets `permission denied` on `net.*` | job breaks, or `wa_gateway` still reaches `net` |
| S-6 (PR-3 / PR-4 replay) | Run the PR-3 and PR-4 scripts through the pooler in transaction mode | identical actors; claims never visible to the next client of the pooled connection (check with a third session reusing connections) | any leak or wrong actor |
| S-7 | Tear down the role and the POC schema | nothing left | — |

### 15.5 Production verification PR-5 (strictly READ-ONLY, owner shell)

One `BEGIN … READ ONLY` transaction, rolled back: `auth.uid()` / `auth.jwt()` definitions; count of SECURITY DEFINER
functions executable by `PUBLIC` (expected 0); default ACLs; `PUBLIC` grants on `net`, `cron`, `extensions`, `vault`;
`service_role` reach (no INSERT on financial tables, no `EXECUTE` on the four RPCs); `postgres` `CREATEROLE`; existing
custom LOGIN roles (expected: none beyond the platform roles). No role is created in production by this step.

### 15.6 Pass / fail for moving ADR-025 to ACCEPTED

PASS only if **all**: PR-1, PR-2, PR-3, PR-4, PR-7 on staging through the pooler; PR-8 (F-1 mitigated without breaking
`pg_net` / `pg_cron`); PR-5 read-only facts match the local ones (0 PUBLIC-executable definers); F-2 guard added to the
verification profiles. FAIL on any privilege beyond `wa.*`, any wrong actor, any claim visible outside its transaction, or
an unmitigated F-1 → fallback (option D, or `wa.*` for `service_role` with database-side signature verification), which
needs a new owner decision.

## 16. Required tests (implementation phase)

- **Authorization**: unknown phone; mapping or profile inactive; OPERATOR profile; A acting on B's draft (correct, confirm,
  cancel, link MP); valid HMAC from n8n but invalid / missing Meta signature; replayed Meta body; `anon`, `authenticated`,
  `service_role` cannot execute `wa.*`; PR-7 as a regression test.
- **Delegated actor**: PR-3 as a regression test, including `claim.sub` pre-set by the caller, error inside the RPC,
  and two calls in one session.
- **Concurrency**: PR-4; double confirmation; confirmation racing a correction; webhook duplicates in parallel; second
  `DRAFT` for one sender refused while `WAITING_MP` drafts do not block (O-10).
- **Idempotency**: crash after the accounting write → same purchase id on retry.
- **Mercado Pago**: never posts without `SOURCE_ID`; already classified → refused; provisional released exactly once.
- **Accounting invariants**: a confirmed draft produces exactly the rows of the same call from the app; cancelled / expired
  / failed drafts leave zero financial rows; balances and P&L unchanged by drafts.
- **Audit**: `created_by` / `performed_by` = human; one `WA_CONFIRM` per confirmation; no audit row claims the gateway.
- **Storage**: private; prefix `wa/`; MIME / size enforced; expired drafts' objects removed; no `service_role` call outside
  the Storage module (code review + test).
- **Expiry**: 48 h `DRAFT`, 72 h `WAITING_MP`; confirming an expired draft → `WA_DRAFT_EXPIRED`.

---

## 17. Staging preparation (2026-10-21)

Evidence below comes from the local Supabase stack (PostgreSQL 17.6, same platform image family) unless marked otherwise;
every production fact is re-checked by the read-only PR-5 script (§17.7).

### 17.1 `pg_net` / `pg_cron` privilege inventory (local)

| Object | Owner | `PUBLIC` privileges | Granted by |
|---|---|---|---|
| schema `net` | `supabase_admin` | `USAGE` (also explicit `USAGE` to `postgres`, `anon`, `authenticated`, `service_role`, `supabase_functions_admin`) | `supabase_admin` |
| `net.http_request_queue` | `supabase_admin` | ALL (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, …) | `supabase_admin` |
| `net._http_response` | `supabase_admin` | ALL | `supabase_admin` |
| `net.http_request_queue_id_seq` | `supabase_admin` | `USAGE`, `SELECT`, `UPDATE` | `supabase_admin` |
| `net.http_get` / `net.http_post` | `supabase_admin`, SECURITY DEFINER | none (explicit to `postgres`, `anon`, `authenticated`, `service_role`, `supabase_functions_admin`) | `supabase_admin` |
| other `net` functions (INVOKER) | `supabase_admin` | `EXECUTE` | default |
| schema `cron` | `supabase_admin` | none (`postgres` has `USAGE` with grant option) | — |
| `cron.job` / `cron.job_run_details` | `supabase_admin` | `SELECT` / `SELECT, DELETE` — unreachable without schema `USAGE` | `supabase_admin` |
| event trigger `issue_pg_net_access` (`ddl_command_end`, owner `supabase_admin`) | — | re-grants `net` schema `USAGE` and `http_get` / `http_post` `EXECUTE` whenever the extension is (re)created | — |

Dependencies: the three cron jobs (`mp_release_report_daily`, `mp_release_report_daily_fallback`, `mp_worker_every_minute`)
run as `postgres` and use `net.*` through the SECURITY DEFINER `net.http_post` (explicit grant to `postgres`); they do not
depend on the `PUBLIC` table grants.

### 17.2 P-10 outcome: not remediable with project privileges

Inside a rolled-back transaction, `postgres` ran `REVOKE ALL ON net.http_request_queue / net._http_response FROM PUBLIC` and
`REVOKE USAGE ON SCHEMA net FROM PUBLIC`: PostgreSQL answered **"no privileges could be revoked"** for every object and the
`PUBLIC` privileges were unchanged — a grant can only be revoked by its grantor (`supabase_admin`) or a superuser, and a
hosted project has neither. PostgreSQL has no per-role deny, so **any** custom LOGIN role inherits these `PUBLIC` grants.
Running S-5 on staging would only re-confirm this. Consequence: the custom LOGIN-role channel (§14.4) **cannot be made
least-privilege on hosted Supabase**; production `pg_net` / `pg_cron` are left untouched (O-18).

### 17.3 Revised gateway channel (P-12): dedicated Auth user through PostgREST

- A Supabase **Auth user** `wa-gateway@<project>.invalid` with **no `perfiles` row** (so `current_app_role()` raises
  `USER_NOT_FOUND_OR_INACTIVE` for it). Its password is an Edge secret; the Edge Function signs in, keeps the 1-hour JWT
  in memory and calls `/rest/v1/rpc/wa_*`.
- The `wa` entry functions live in an exposed schema (`public`, prefix `wa_`), SECURITY DEFINER, `EXECUTE` revoked from
  `PUBLIC`, `anon`, `service_role` and granted to `authenticated`; **each begins with**
  `IF auth.uid() IS DISTINCT FROM (SELECT gateway_user_id FROM wa.config) THEN RAISE 'FORBIDDEN'`, so the two ADMINs and
  the OPERATOR cannot call them from the app. The `wa` tables stay in the non-exposed schema `wa`.
- PostgREST exposes only `public` and `graphql_public` (local configuration: `PGRST_DB_SCHEMAS=public,graphql_public`): the
  `net`, `cron`, `vault` objects are unreachable from this channel, whatever their `PUBLIC` grants — **F-1 is neutralized
  structurally**, with no change to platform permissions.
- What the gateway user can reach otherwise (local audit): 75 callable SECURITY DEFINER functions are executable by
  `authenticated`; 73 call `current_app_role()` first and refuse a profile-less user; the other 2 are `current_app_role`
  itself (raises) and `assert_period_open` (read-only period check). RLS policies are profile-based. To be re-proven on
  staging as PR-7R.
- The delegation of §14.3 is unchanged: PostgREST sets the gateway user's claims per request (transaction-local);
  `wa_confirm_draft` overwrites both claims with the draft owner, asserts, calls the RPC and restores — exactly what PR-3 /
  PR-4 proved; PR-3R / PR-4R repeat it through PostgREST.
- A leaked gateway password allows only the `wa_*` functions, whose identity proof is the Meta signature checked with a
  Vault secret this user cannot read; no pooler, no custom LOGIN role, no minted JWT, no JWT secret in the Edge Function.

### 17.4 P-11 implementation (O-19)

Check **Q** added to `ADR018_POST_0100` (verification profile; no migration touched): callable SECURITY DEFINER functions
(return type not `trigger` / `event_trigger`) in the application schemas `public` and `wa` that `PUBLIC` can execute must be
none. Local run: POST_0100 48/48 OK including Q; negative control (a PUBLIC-executable definer created inside a rolled-back
transaction) detected. Every future POST profile inherits it. Pending: commit with the next profile change, after PR-5
confirms production also returns none.

### 17.5 PR-9 — Meta HMAC over raw bytes (local, dummy secret)

The database computes `'sha256=' || encode(extensions.hmac(decode(raw_b64, 'base64'), secret, 'sha256'), 'hex')` and
compares it with the header. 8/8 cases matched Node's `crypto.createHmac` (Meta's algorithm): original bytes VALID;
re-serialized JSON (escaped `á` → `á`, 244 → 240 bytes), pretty-printed JSON, one flipped bit, another secret, missing
`sha256=` prefix, upper-case hex and empty header all INVALID. Constraints for the implementation: the Edge Function must
pass `await req.arrayBuffer()` base64-encoded, never a parsed / re-stringified body; header format enforced
(`^sha256=[0-9a-f]{64}$`); the two HMACs compared through a second HMAC (or digest equality) to avoid a timing-dependent
text comparison.

### 17.6 Staging environment, reproducibility and cost

- **Host**: a separate Supabase project with no production data (P-13). Supabase's Free plan allows a limited number of
  active free projects; whether a slot is free in the owner's organization must be checked in the dashboard before
  provisioning (the legacy projects count if active). Alternative: Supabase Branching, which requires a paid plan plus
  per-branch compute. Edge Functions, Vault, `pg_net`, `pg_cron`, `pgcrypto`, Auth and PostgREST are available on the free
  plan. Expected staging load: a few hundred rows of synthetic data and a handful of Edge invocations. Prices and limits
  must be confirmed on Supabase's pricing page at provisioning time (not asserted here).
- **No other external service** is needed for PR-1R … PR-9R: no Meta app, no n8n (they come only in the later end-to-end
  phase; a Meta test number is free).
- **Schema**: migrations 0001–0100 from the repository at the deployed commit. `scripts/phase31/provision-target.mjs` only
  accepts `PRODUCTION_TARGET` / `LOCAL_PROVISION_REHEARSAL` and its static expectations stop at 0072 → a `STAGING` kind (or
  a staging entry in the runner) is a small preparatory change; verification uses `ADR018_POST_0100` (with check Q).
- **After provisioning (staging only)**: deactivate the three MP cron jobs (`cron.alter_job(…, active := false)`) — they
  would call Edge Functions with Vault secrets that do not exist there; no MP webhook, no Vault business secret.
- **Synthetic data only**: Auth users `admin-a@staging.invalid`, `admin-b@staging.invalid` (ADMIN profiles),
  `oper@staging.invalid` (OPERATOR), `wa-gateway@staging.invalid` (no profile); one supplier; the seeded categories and
  accounts; one open management period. Every proof transaction rolls back; no permanent financial record.

### 17.7 Execution order and gates (staging; PR-5 production read-only)

| Order | Proof | PASS gate | On FAIL |
|---|---|---|---|
| 0 | **PR-5** production read-only (`adr025-pr5-readonly.sh`, session scratchpad; one `READ ONLY` transaction, no role, no grant) | 0 PUBLIC-executable application definers; `auth.uid()` reads `claim.sub` then `claims`; `service_role` 0/11 financial writes and no accounting RPC; no custom LOGIN role; PostgREST schemas `public`, `graphql_public` | stop; re-review the design with the real facts |
| 1 | Provision staging 0001–0100, POST_0100 (with Q) | profile PASS | fix provisioning, never production |
| 2 | **PR-1R** gateway Auth user signs in; JWT role `authenticated`, `sub` = gateway user; no `perfiles` row | as stated | stop |
| 3 | **PR-7R** with that JWT through PostgREST: every non-`wa_` RPC refused (`USER_NOT_FOUND_OR_INACTIVE` / `FORBIDDEN`); tables / storage refused; `net`, `cron`, `vault` not reachable (schema not exposed); `wa_*` callable; an ADMIN JWT calling `wa_*` → `FORBIDDEN` | all refusals and the one allowance exactly as stated | stop: any extra reach is a FAIL |
| 4 | **PR-2R** minimal Edge Function (Auth sign-in + one `wa_confirm_draft` call on a rolled-back prototype, no `service_role` in that path) | call succeeds; result as PR-3 | stop |
| 5 | **PR-3R** delegation through PostgREST | actor = draft owner in `created_by` / `performed_by`; caller's claims restored; replay / stale / OPERATOR / error cases as §15.2 | stop |
| 6 | **PR-4R** concurrency: two Edge calls (A, B) overlapping + a third request reusing PostgREST connections | each actor correct; the third request sees only its own claims | stop |
| 7 | **PR-9R** HMAC: the Edge Function forwards `arrayBuffer` bytes; signed fixtures (dummy secret in staging Vault) → VALID / tampered → INVALID | 8/8 as §17.5 | stop |
| 8 | Tear-down of the prototype objects; staging kept for the implementation phase | nothing of the prototype left | — |

ADR-025 may move to ACCEPTED only when 0–7 PASS; the custom LOGIN-role channel (§14.4, PR-1 / PR-2 / PR-8 of §15) is
superseded by this sequence if P-12 is accepted.

---

## 18. Minimal staging (owner decision 2026-10-21 — supersedes the full-ERP staging of §17.6–§17.7)

**Decision (O-21):** the 100 ERP migrations are **not** installed in AppGranja; `provision-target` STAGING and the timezone
fix (§17) are cancelled. AppGranja (`aplbsutpzgemexayldct`, already reset: 0 tables, 0 Auth users, no Edge Functions, no
non-platform secrets, signups disabled) hosts a **light, isolated bot staging** to iterate fast on WhatsApp, n8n, the AI
interpretation, confirmations and security. Real accounting is proven on the **local** full ERP (§18.4) and, last, on
production behind a closed flag (§18.5).

### 18.1 What is created in AppGranja (nothing else)

| Object | Schema / exposure | Purpose |
|---|---|---|
| `wa.config` (`gateway_user_id`, `enabled`) | `wa` — not exposed | the one gateway Auth user; master switch |
| `wa.sender` (phone E.164 → `perfil_id`, `activo`) | `wa` | the two fictitious ADMINs' test phones |
| `wa.inbound_message` (`wamid` UNIQUE, raw SHA-256, signature_ok, sender) | `wa` | reception, deduplication, evidence |
| `wa.draft`, `wa.draft_version` (state machine §4.2, partial UNIQUE one-open rule, `WAITING_MP` cap 5, expiry 48 h / 72 h) | `wa` | drafts, corrections, cancellation, expiry |
| `wa.confirmation` (`draft_id` UNIQUE, idempotency key, result) | `wa` | confirmation + idempotency |
| `wa.audit_event` (actor, channel, action, draft, version, hashes) | `wa` | audit of every gateway action |
| `sim.perfiles` (id = Auth user id, email, `rol_type`, `activo`) + `sim.current_app_role()` | `sim` — not exposed | the ERP identity contract: `auth.uid()` → active profile → role |
| `sim.expense_category` (a handful of rows: selectable, reserved, owner-withdrawal), `sim.financial_account` (Caja chica, BNA, Mercado Pago) | `sim` | data the drafts reference |
| `sim.mp_pending_outflow` (`source_id`, amount, date, `classified_at`) | `sim` | WAITING_MP linking and "never twice" |
| `sim.purchase`, `sim.audit_event` | `sim` | the simulated accounting result (`created_by` = actor) |
| `sim.register_casual_purchase(...)`, `sim.register_purchase(...)`, `sim.register_fiscal_document(...)` | `sim`, SECURITY DEFINER, no API grant | **contract doubles**: same parameters as the real RPCs; the same guards that matter to the bot — ADMIN via `sim.current_app_role()`, idempotency key UNIQUE + replay / `DUPLICATE_PURCHASE`, category not selectable → `CATEGORY_NOT_SELECTABLE`, MP paid ⇒ `MP_SOURCE_REQUIRED` / `ALREADY_CLASSIFIED`, amounts > 0, business date in America/Argentina/Buenos_Aires — and nothing else (no postings, ledgers, P&L) |
| `public.wa_ingest`, `wa_propose`, `wa_correct`, `wa_cancel`, `wa_link_mp`, `wa_confirm`, `wa_expire` | exposed, SECURITY DEFINER, `EXECUTE` only `authenticated`, each starts with the gateway gate (`auth.uid()` = `wa.config.gateway_user_id` and `enabled`) | the only API surface |
| Vault `wa_meta_app_secret` (Meta **test** app secret) | Vault | HMAC verification inside `wa_ingest` |
| Private bucket `wa-receipts-staging` | Storage | original receipts (test images only) |
| Edge Function `wa-gateway` | staging | Meta webhook → raw bytes → `wa_ingest` → n8n; receipt upload |

Auth: four synthetic users — `admin-a@staging.invalid`, `admin-b@staging.invalid` (ADMIN), `oper@staging.invalid`
(OPERATOR), `wa-gateway@staging.invalid` (no profile). The delegation inside `wa_confirm` is exactly §14.3 (both claims,
transaction-local, assert, restore), dispatching to the `sim.*` doubles. The DB time zone of AppGranja
(America/Argentina/Buenos_Aires, §17) is irrelevant because every function converts explicitly — the same rule as the ERP.

### 18.2 Authorization barriers kept, with negative tests

Unknown phone; mapping or profile inactive; OPERATOR owner; admin A acting on B's draft; ADMIN / OPERATOR / anon calling
`wa_*` (FORBIDDEN); gateway calling `sim.*` or reading `wa` / `sim` tables (not exposed / denied); `net`, `cron`, `vault`
not reachable through PostgREST; forged claims by the caller never change the actor; invalid / re-serialized / replayed
Meta signature; stale version, double confirmation, retries, concurrent confirmations of A and B; expired draft; second
open draft refused while `WAITING_MP` does not block. The §17 scripts are reused where they fit: `06-gateway-proofs.mjs`
(PR-1R, PR-3R, PR-4R, PR-7R, PR-9R), `03-staging-users.sh`, `08-wa-gateway-probe/`.

### 18.3 Edge Function ↔ n8n without production secrets

- Meta: a **test** WhatsApp app and test number (free tier); the two owners' phones as test recipients. Its app secret
  lives only in AppGranja's Vault; its access token only in the staging n8n credentials.
- Edge Function `wa-gateway` (AppGranja): receives the webhook, passes `arrayBuffer()` base64 + header to `wa_ingest`,
  then calls the n8n webhook with an HMAC (body + timestamp + nonce; staging-only secret, separate per direction).
- n8n (Railway): a **separate staging workflow and credential set** (names prefixed `STAGING_`), pointing only at
  `https://aplbsutpzgemexayldct.supabase.co/functions/v1/wa-gateway`; never a production URL, key or token. Execution logs
  ≤ 7 days, no media (O-12).
- No Mercado Pago, bank or ERP production credential exists in AppGranja or in the staging workflow.

### 18.4 Integration with the REAL accounting RPCs — local full ERP

The local database (0001–0100, the same one used for every gate) gets the **candidate `wa` migration** (the production
version: `wa_*` dispatching to the real `register_casual_purchase`, `register_purchase`,
`register_purchase_with_fiscal_document`, `register_fiscal_document`). Mandatory local suite: the §16 tests against the
real RPCs — actor in `purchases.created_by` / `audit_events.performed_by`; idempotent replay; category guards (0096 / 0099);
MP `SOURCE_ID` linking against an ADR-021 provisional fixture (exactly one release); period closed; fiscal document
uniqueness; financial delta 0 for cancelled / expired / failed drafts; SECURITY DEFINER inventory and the POST profile
(with check Q) extended to the `wa` objects.

### 18.5 Mandatory final gate before any financial write in production

1. Local suite of §18.4: PASS.
2. PR-5 production read-only (§17.7, step 0): PASS.
3. Production migration of `wa` with `wa.config.enabled = false` (every `wa_*` refuses) + POST profile: PASS.
4. Production Edge Function deployed with the flag still off; signature and authorization probes against production with
   no financial effect (unknown phone, forged signature, ADMIN calling `wa_*`): all refused.
5. Owner GO → flag on for the two mapped phones only; one real low-value expense confirmed from WhatsApp; verify actor,
   audit, idempotency (repeat the "SÍ"), amounts; then its rectification / cancellation through the normal ERP path.
6. Pilot (§11 phase 5).

### 18.6 What the minimal staging proves — and what it does NOT

| Proves (staging) | Does NOT prove (covered by §18.4 / §18.5) |
|---|---|
| Meta webhook → Edge → raw-byte HMAC in the database | real postings, ledgers, P&L, supplier debt |
| n8n / AI interpretation loop, confirmation texts, corrections | MP provisional release (ADR-021) against real data |
| sender mapping, ownership of drafts, OPERATOR / anon / ADMIN refusals | the ERP's RLS, category / strict-parent guards of 0096 / 0099 |
| drafts, versions, one-open rule, `WAITING_MP`, expiry | fiscal document rules and uniqueness of the real model |
| idempotency (`wamid`, double "SÍ", retries) and concurrency | production SECURITY DEFINER inventory / POST profile / check Q |
| delegated identity through PostgREST (§14.3), restoration, no leakage | production Auth settings, pooler, rate limits |
| `net` / `cron` / `vault` not reachable; Storage privacy of receipts | production performance, real MP data shapes |
| audit trail of every gateway action | that the doubles behave exactly like the real RPCs (only §18.4 proves it) |

**Status (2026-10-21):** design only at the time; superseded by §19. The §17 full-ERP staging scripts (`staging-adr025/`)
and the `wa-poc/` proof scripts are **not** kept in the repository; their results are recorded in §15 and §17.

---

## 19. Staging results and production cutover status (2026-10-22 / 23)

### 19.1 What runs in STAGING (AppGranja `aplbsutpzgemexayldct`)

| Component | State |
|---|---|
| Schemas `wa` + `sim`, `public.wa_*` (8 functions incl. read-only `wa_context`) | installed; upgrades 001 (`wa_context`), 002 (sim categories Combustible / Limpieza / Mantenimiento), 003 (`wa.duplicate_refs`, `duplicates` in `wa_propose` / `wa_correct`) applied and verified read-only |
| Edge Function `wa-gateway` | v2 (adds the read-only `context` action); security probes 6/6 refused (Meta verify with a wrong token, unsigned / forged webhook, unsigned action, `context` without / with a wrong token) |
| n8n (Railway, one instance) | `STAGING - Gastos WhatsApp v2` (`dHVBoiFpgszCxpEf`) active, version `a9644024`; the rule-based v1 (`n2N9KmrfiOyHhBRl`) inactive (rollback) |
| Interpreter | OpenAI Responses API, Structured Outputs, `gpt-5.6-luna` / `reasoning.effort = none`, `store: false`; evaluation 30/30, 0 hard failures, p95 2 920 ms, ≈ USD 0.00024 / text message; GPT only proposes, every field is re-validated deterministically and by the database |
| Meta | test app / test number; webhook verified and the app subscribed to the WABA |

Real WhatsApp tests (simulated accounting only, `sim`): W-0007 confirmed (purchase recorded once, audit by the owner);
W-0008 cancelled (no purchase); W-0009 (old rule parser defects: "18mil" read as 18, the correction overwrote the concept)
cancelled — both defects fixed by the interpreter; W-0010 proposed by GPT correctly ("18k" → 18 000) but the reply was lost
(see F-4); W-0011 "18mil" → 18 000, then "Perdón eran 15mil" → v2 15 000 with every other field kept.

### 19.2 Findings during staging

- **F-4** — Meta HTTP errors were silent: `Send WhatsApp` uses `neverError` and the workflow does not save successful
  executions, so an expired temporary Meta token left no trace. Fixed: `Log send` throws on a non-2xx Graph answer (HTTP
  status + Meta numeric code / subcode / type only; no token, phone, text or Meta free text), so the execution fails and is saved.
- **F-5** — the duplicate hint ("Hay 1 gasto(s) parecido(s)") named no purchase. Diagnosis: it matched W-0007 (same total,
  date within ±2 days, another category) — a correct hint, not a false positive. Fixed without changing the criterion:
  `wa.duplicate_refs` returns up to 3 references (WhatsApp code, category, concept, date, total, same-category flag); the
  details are returned only when the viewer is an active mapped ADMIN, otherwise date / total / same-category only.
- **F-6** — UX: corrections now show "✏️ Corregí W-xxxx (vN): <campo> antes → después" and mark the changed line; the help
  and the confirmation footer explain partial corrections ("eran 15 mil", "era transferencia").
- **F-7** — the temporary Meta token expires (≈ 24 h); production needs a permanent System User token (§19.4 B-1).

### 19.3 Artifacts and test results (repository: `integrations/whatsapp/`)

| Path | Content |
|---|---|
| `wa-staging/src/`, `build.mjs`, `build/` | one SQL template → staging build (`sim` doubles) and the ERP candidate migration `build/candidate/0101_wa_whatsapp_gateway.candidate.sql` (real RPCs, `wa.config.enabled = false`); staging upgrades 001–003 |
| `wa-staging/run-staging-sandbox.sh`, `run-candidate-local.sh` | local suites (disposable sandbox; local ERP inside a rolled-back transaction) |
| `wa-staging/hosted/` | owner-shell scripts for AppGranja (identity + fingerprint guards, private password prompt, read-only verifications) |
| `wa-gateway/supabase/functions/wa-gateway/`, `tests/` | Edge Function and its tests |
| `wa-gateway/n8n/` | n8n logic, interpreter, workflow builder, merge / preflight (P-1…P-11), tests, model evaluation, MCP change reports |

Not in the repository (secrets, environment data or run outputs): Edge / n8n secrets, synthetic user passwords, the staging
catalog (`staging-catalog.json`), generated n8n builds, hosted workflow exports and every `*-output.txt`.

Latest results: SQL staging sandbox 85/85; SQL candidate on the local ERP (0001–0100) 85/85, no residue; n8n logic 7/7,
interpreter 12/12, workflow 12/12 (also against a copy of the published v2); Edge 14/14; n8n preflight 11/11.

### 19.4 Production cutover — blockers

| # | Blocker | Status |
|---|---|---|
| B-1 | Production Meta: real number, production app / WABA (one app has one webhook; reusing the test app would end staging) and a **permanent System User token** | **open** — independent production configuration, pending (owner) |
| B-2 | Transfer account: production has BNA and Patagonia | **decided** (owner): when the account is not stated, ask which one before a confirmable draft; accounts read live from the ERP (D-3, §19.6) |
| B-3 | Cutover scope | **decided** (owner): `CASUAL_EXPENSE` from text only (cash / transfer / Mercado Pago with `SOURCE_ID`); audio, invoices, credit purchases and VAT-only documents out of the cutover |
| B-4 | Production parity, read-only | **CLOSED — PASS** (2026-10-23): `integrations/whatsapp/production/b4-parity-readonly.sh`, one READ ONLY transaction, rolled back, 0 writes. Eight groups PASS: identity (ledger 0100, `auth.uid()` unchanged), the four RPC signatures / owner / grants and every column 0101 reads, PR-5 security (0 PUBLIC-executable definers, no custom LOGIN role, `service_role` 0/11 financial writes), accounts (Caja chica, BNA, Patagonia, Mercado Pago `EXTERNAL_SERVICE`), 49 selectable subcategories with unique names, payment methods, no `wa` / `sim` objects and no `wa-gateway` function. The ERP has 4 active ADMIN profiles (more than two is allowed); the pilot profiles are **owner `7986da00`** and **brother `b4305ca5`** (8-char id prefixes; validated by `b4-admin-candidates.sh`: A-1 ≥ 2 eligible ADMIN with a valid Auth user, A-2 prefixes unique, A-3 two distinct prefixes, A-4 each matches exactly one eligible ADMIN — all PASS). The identification (`b4-admin-emails.sh`) shows Auth emails on the owner's terminal only and is not to be repeated. |
| B-5 | Artifacts versioned in the repository | **done** — commit `55aa19f` on branch `adr025-whatsapp-gateway` (local, not pushed) |
| B-6 | ADR-025 to ACCEPTED | **open** — after B-1 and D-3 |

Isolation STAGING ↔ production rests on independent barriers: different Meta app secrets (a staging signature does not
verify in production), different Edge ↔ n8n tokens and webhook paths, project-ref constants in the Edge Function, and the
production `wa.sender` holding only the two real numbers. Condition: staging and production must **not** share a Meta app.
Other risks: n8n keeps failed-execution data (phone, text) — production retention ≤ 7 days (O-12) needs an n8n instance
setting; a separate production OpenAI credential is recommended.

Production order (each step with its gate; owner GO for every hosted step): read-only parity → decisions → production builds
(Edge with production ref constants, n8n PROD variant: endpoints, `phone_number_id`, texts without "STAGING", `PROD_*`
credentials, own webhook path) + preflight → local rehearsal of 0101 + POST profile → migration 0101 with the flag off →
gateway Auth user, `wa.sender`, Vault secret → Edge deploy + probes → Meta webhook → n8n PROD imported inactive, then
published → flag on, propose + cancel → one real low-value expense (§18.5) → pilot. Rollback, fastest first:
`wa.config.enabled = false`; unpublish the PROD workflow; unsubscribe the production webhook; migration 0101 is additive
(drop `wa_*` and schema `wa` only after keeping its evidence); confirmed purchases are rectified through the ERP, never deleted.

### 19.5 D-1 — live ERP catalog of categories and subcategories (approved by the owner 2026-10-23; local, not deployed)

- **Single source of truth**: the ERP catalog, read live on every message by `wa_context` through `wa.selectable_categories()`
  (subcategory id and name, parent category id and name). Nothing is hard-coded in n8n, the Edge Function, the interpreter or
  the OpenAI prompt; nothing is kept in n8n static data (only nonces, seen messages and the hourly limit). Additions,
  renames, moves and deactivations are visible on the next message, without redeploy.
- **Interpretation**: GPT receives "category › subcategory" with an opaque code per option (`S1…Sn`, built per message);
  the Structured Outputs enum allows only those codes; the code maps to the subcategory **id**, the only key of the draft and
  of the accounting call (ids are never sent to OpenAI). If the message names a category with several subcategories and
  not which one (e.g. "combustible" → Nafta / Gasoil), the bot asks; it never guesses.
- **One selectability rule** (`wa.category_check`): active subcategory, not fiscal-reserved, inside an **active EXPENSE
  category**. Used by the catalog, by `wa_propose` / `wa_correct` (`WA_CATEGORY_NOT_SELECTABLE`) and **inside the
  confirmation transaction** before the accounting RPC, with `FOR SHARE` on the subcategory and its category (a concurrent
  deactivation waits for the commit). A refused confirmation leaves the draft `FAILED` with 0 purchases; a category-only
  correction keeps every other field and the draft can be confirmed.
- **Owner decision**: this rule is **stricter than the current ERP interface**, which can still record an active
  subcategory whose parent category is inactive (the real `register_casual_purchase` checks the subcategory only; the 0096
  guard rejects reserved / owner-withdrawal subcategories). The ERP interface is **not** changed in this scope; the
  accounting RPCs are not modified.
- Staging upgrade `upgrade-004-catalog-rule.sql` (prepared, **not applied**): additive; the published staging workflow
  ignores the new catalog fields. `upgrade-001` is regenerated with the new `wa_context` and must not be re-applied.
- Tests: SQL staging 94/94 and candidate on the local ERP 94/94 (K-1…K-9: new, renamed, moved, deactivated subcategory,
  deactivated category, change between proposal and confirmation, category-only fix); n8n logic 8/8, interpreter 15/15
  (codes, hierarchy, catalog changes, ambiguity), workflow 13/13 (end to end); Edge 14/14.

### 19.6 D-3 — live paying accounts (local, not deployed; pending owner review)

- **Single source of truth**: the enabled paying accounts are read live on every message by `wa_context` through
  `wa.selectable_accounts()` (id, name, type and the **method** each one serves). No account name exists in n8n, the
  interpreter, its configuration (`account_by_method` removed) or the OpenAI prompt; account names are **not sent to
  OpenAI** at all. Additions, renames and deactivations are visible on the next message, without redeploy.
- **One account rule** (`wa.account_check`): an active account whose type gives the method — `CASH` → cash,
  `BANK_ACCOUNT` → transfer, and the Mercado Pago account the ERP itself recognises in `register_casual_purchase` (name
  "Mercado Pago", `EXTERNAL_SERVICE`) → Mercado Pago; any other account is not offered. **Stricter than the ERP RPC**,
  which does not tie the method to the account type. Used by `wa_propose` / `wa_correct` (`WA_ACCOUNT_NOT_SELECTABLE`) and
  **inside the confirmation transaction** with `FOR SHARE` (a disabled account → `FAILED`, 0 purchases).
- **Choosing the account (deterministic, safe)**: in a new expense an account is taken only when the message contains its
  **whole name as a phrase** (whole words, contiguous — "cajas" is not "Caja", "pago en el mercado" is not "Mercado Pago");
  among several matches only the most specific survives ("banco nación" → "Banco Nación", not "Banco"); two different
  accounts named → asked, never auto-selected. Naming one decides the method; a contradiction ("en efectivo desde
  Patagonia") is asked. With a single enabled account for the method no question is asked. When **answering** the
  account question, a whole word that identifies exactly one offered account is enough ("galicia" → "Banco Galicia"; "banco"
  with two "Banco …" offered → asked again). The selection always resolves to the account **id**.
- **Several clarifications on one draft**: a subcategory that is ambiguous ("combustible" → Nafta / Gasoil) or not stated is
  also kept **pending** (`category_pending`, the offered `category_options` validated by the database) instead of asking
  without a draft — amount, concept and date are never lost. A draft with any datum pending has **no confirm button** and
  lists every question ("Me faltan dos datos: …"); the database refuses its confirmation (`WA_CATEGORY_REQUIRED` /
  `WA_ACCOUNT_REQUIRED`, the draft stays `DRAFT`, nothing recorded). Each answer sets only its datum, deterministically
  (no GPT), one per message or both at once; one draft, one confirmation, one purchase.
- **Differences with the ERP accounting RPC (`register_casual_purchase`, not modified)**: the RPC accepts any active account
  with any method except `CHEQUE`; the bot ties the method to the account type and offers no `EXTERNAL_SERVICE` account other
  than the ERP's Mercado Pago account (the RPC would book such an account as a plain payment). The rules that remain the
  RPC's own and surface as a `FAILED` draft with its error: Mercado Pago requires a payout `SOURCE_ID` (the bot keeps the
  draft `WAITING_MP`), `MP_AMOUNT_MISMATCH` / `MP_DATE_MISMATCH`, `ALREADY_CLASSIFIED`, `OWN_ACCOUNT_PAYOUT`,
  `DESTINATION_REVIEW_REQUIRED`, `PERIOD_CLOSED`, `DUPLICATE_PURCHASE`. Subcategories: the RPC checks the subcategory is
  active and the 0096 guard rejects reserved / owner-withdrawal ones; the bot also requires an active parent category.
- **Several accounts, none named** (B-2): the draft is created **without account** (`account_pending`), shown **without
  the confirm button**, and the bot asks "¿Desde qué cuenta lo pagaste? BNA o Patagonia". The database refuses to confirm
  it (`WA_ACCOUNT_REQUIRED`, the draft stays `DRAFT`, nothing recorded). The answer ("Patagonia") is applied without GPT as
  an account-only correction; later corrections ("era BNA") change only the account (and its method), never the amount,
  concept or category. The correction header shows "Cuenta antes → después".
- Compatibility: the staging upgrade `upgrade-004-catalog-rule.sql` (prepared, **not applied**) now carries D-1 and D-3; a
  context without the account method (staging today) falls back to the account **type**, never to a name.
- Tests: SQL staging 108/108 and candidate on the local ERP 108/108 (P-1…P-9 accounts; M-1…M-5 subcategory AND account
  pending on one draft, each refused at confirmation until set, one purchase at the end); n8n logic 9/9, interpreter 21/21
  (incl. I-19 safe account matching, I-20 several clarifications, I-21 answers by a distinctive word), workflow 15/15
  (WF-14 accounts, WF-15 several clarifications end to end); Edge 14/14.
- **Model evaluation v2** (`n8n/eval/golden-set-v2.json`, 34 cases: categories with hierarchy, several clarifications,
  BNA / Patagonia transfers, future and similar account names, account correction, ambiguous messages, injection). The
  harness runs the production path (preRoute → GPT → decide). Offline harness test (`eval-offline.mjs`, simulated answers on
  127.0.0.1): 34/34 with the ideal answers and the sabotage run caught (wrong amount HARD; guessed subcategory kept pending;
  contradicted method asked; obeyed injection refused) — this validates the harness only. **The real-model evaluation is
  PENDING**: `eval-models.sh` (key typed privately by the owner); no real-model PASS is claimed.

### 19.7 C01 / C03 — no arbitrary rewrite of the concept (owner decisions 2026-10-23; local)

- Real-model evaluation of 2026-10-23 (n8n credential `STAGING_OPENAI_GRANJA`, temporary workflow, archived): `luna/low` 32/34,
  `luna/none` 31/34; hard failures C01 ("era Patagonia" also rewrote the concept) and C03 ("era gasoil" rewrote the concept).
- **C01**: a message that only names the paying account ("era Patagonia", "no, desde BNA") corrects ONLY the account and its
  method; whatever the model proposes for concept, amount, subcategory or date is ignored (deterministic).
- **C03**: on a subcategory correction the concept follows ONLY when it is exactly the replaced subcategory ("Nafta" + "era
  gasoil" → concept and subcategory "Gasoil"); a descriptive concept ("Combustible para tractor", also "nafta para el tractor")
  is kept. Otherwise a concept change is accepted only with all its words in the message; the model never rewrites it.
- Re-judging the recorded real answers with these guards: `luna/low` 34/34, 0 hard; `luna/none` 33/34 (A07). A focused real
  re-evaluation (C01, C03, C05–C08) is prepared and NOT run.

### 19.8 Unclassified expenses with financial effect (owner decisions 2026-10-23; local — ERP candidate 0102 + wa stage 2)

**Decisions (approved).**
1. The money event and the classification are separate. A confirmed expense whose subcategory is doubtful is recorded at once:
   ONE `PURCHASE_PAYMENT` operation, ONE posting on the paying account (the balance drops now), ONE pending classification. The
   classification later (ERP) only adds the purchase on THAT payment — no new purchase, payment, movement or balance change.
2. Never a fictitious category, "Otros" or a default subcategory. Unclassified expenses appear in the P&L as
   `GASTOS_SIN_CLASIFICAR`, inside the operating result and every later subtotal; classifying moves the line, the total does not change.
3. A month with unclassified expenses cannot be closed (same criterion as the Mercado Pago pending outflows).
4. Mercado Pago: its outflow already reaches the balance through the ADR-021 provisional and waits in its own pending list;
   WhatsApp never records a second outflow (the ERP RPC refuses the Mercado Pago account: `MP_USE_PENDING_OUTFLOW`).
5. WhatsApp: classified → "Confirmar" (unchanged); doubtful classification → the explicit, separate button "Confirmar sin
   clasificar" (Meta limits a reply-button title to 20 characters; owner decision of stage 3: **"Registrar sin clasif"** — "Registrar sin clasif." has 21 characters, so it is shown without the final period; the button id stays `UNCLASSIFIED:<draft>:<version>`). Both require the
   explicit button of the current version; without every financial datum (amount, date, account, method) no confirmation is
   offered and the database refuses it (`WA_ACCOUNT_REQUIRED`).
6. `classify_pending_expense` requires the subcategory AND its category active (the bot's selectability rule); the general
   purchase validation of the ERP is not changed.

**ERP — candidate `supabase/target-candidates/0102/` (not applied anywhere).** Tables `expense_pending_classification` /
`expense_pending_resolution` (immutable, RLS ADMIN read-only, no API write); RPCs `register_unclassified_expense` (ADMIN,
idempotent by key, same lock namespace as `register_casual_purchase`) and `classify_pending_expense` (ADMIN, row lock,
replay / `ALREADY_CLASSIFIED`; reclassification through the existing `rectify_casual_purchase_classification`); deferred
integrity triggers (no `EXPENSE-PENDING` payment without its pending and exactly one posting, no purchase on a pending payment
without its classification); a separate period-close trigger (`PENDING_EXPENSE_CLASSIFICATION`); view
`fin_expense_pending_classification`; `pnl_line_item` / `pnl_summary` with the new bucket / appended column. Not modified:
`register_casual_purchase`, `rectify_casual_purchase_classification`, ADR-021 / 0091 functions and triggers,
`management_period_close_guard`, `fin_match_statement_line`. Bank lines (BNA, Patagonia) reconcile against the single posting
before and after the classification.

**WhatsApp — stage 2 (`wa-staging/src`, n8n `logic.js`).** `wa_confirm` reads the stored button: `CONFIRM:<draft>:<v>` →
classified (unchanged); `UNCLASSIFIED:<draft>:<v>` → only for a `CASUAL_EXPENSE` whose subcategory is still to choose and whose
account is set; cash / bank → `wa.dispatch_unclassified` → `register_unclassified_expense` with the draft key
`WA:<draft>:v<n>` (one draft version = one expense, whichever button), origin `WHATSAPP` and the draft reference; Mercado Pago
(linked to its SOURCE_ID, still pending) → no accounting call, the draft records the explicit confirmation. Edge Function
unchanged (button ids are passed through; action `confirm`). n8n: the button appears only when the subcategory is the ONLY
datum left, with the explanation of the effect; the reply after confirming says SIN CLASIFICAR. Staging: a `sim` double of
the RPC; `upgrade-004` extended additively (the `CONFIRM` button keeps its exact behaviour for the deployed workflows) — NOT applied.

**Tests (local).** ERP 0102: 57/57 (rolled back on the local ERP) + 13/13 concurrency / real COMMIT on a disposable clone;
WhatsApp SQL: staging sandbox 124/124 + races R1–R5 (R5: two simultaneous "Confirmar sin clasificar" → one pending, one
confirmation), candidate on the local ERP with 0102 124/124 (section U: safe / ambiguous classification, unclassified and
normal confirmation, retries and double tap, incomplete financial data, corrections before confirming, deactivated
subcategory, Mercado Pago without a second outflow, later classification without balance change); n8n logic 10/10,
interpreter 24/24, workflow 17/17 (WF-16 / WF-17); Edge 14/14; offline evaluation harnesses 37/37.

**Residual risks.**
- Order of application: the WhatsApp migration (0101) calls `register_unclassified_expense` (0102). 0102 must be applied first
  (or the two renumbered at merge time); otherwise an unclassified confirmation ends `FAILED` with the missing-function error
  (nothing recorded).
- The ERP P&L screen does not show `gastos_sin_clasificar` yet (stage 3); it is already inside the operating result.
- No ERP screen yet to list / classify pending expenses (stage 3); the view and the RPC are ready and permission-checked.
- A Mercado Pago "sin clasificar" confirmation records nothing in the ERP; the concept typed in WhatsApp stays only in the draft
  (not yet shown next to the MP pending outflow).
- The same expense entered by hand in the ERP and by WhatsApp is still possible (pre-existing risk; duplicate references remain
  a warning).
- The real-model evaluation did not include "Confirmar sin clasificar" (a button, no model involved) — nothing to evaluate there.

### 19.9 Stage 3 — ERP screen "Gastos sin clasificar" (owner GO 2026-10-23; local, frontend + 0102 contract)

**Decisions.** WhatsApp button title "Registrar sin clasif" (§19.8). Mandatory order of application **0102 → 0101** until the
final numbering is reviewed at the cutover. `classify_pending_expense` requires the subcategory AND its category active.

**Screen (Caja → "Gastos sin clasificar", ADMIN only — Caja is an ADMIN module and refuses any other role).** Indicator (server
count of unclassified expenses, also as a badge on the tab), filters by status / date range / account / origin (server-side),
paginated list from `fin_expense_pending_classification` (date, amount, concept, account, origin "WhatsApp W-0042" or "ERP", who
registered it, status, category and classifier once classified). "Clasificar" opens the form: category → subcategory (only
selectable ones: active subcategory in an active EXPENSE category, reserved ones never offered), nature (pre-filled from the
subcategory, editable), concept (registered one, editable), counterparty (optional), audit note. The only write is the RPC
`classify_pending_expense`; the list, the P&L and the treasury views are refreshed after it (also after a concurrent
`ALREADY_CLASSIFIED`). Mercado Pago pendings are shown as a summary with a shortcut to "Pendientes de clasificar" (their
ADR-021 routes), never duplicated. Finanzas: the P&L shows the line **"Gastos sin clasificar"** just before "Resultado
operativo" (a component, read from `pnl_summary`, never re-added) and the drill-down labels the `GASTOS_SIN_CLASIFICAR` bucket.
The account history labels an `EXPENSE-PENDING:` payment "Gasto (sin clasificar al registrarse)".

**Contracts.** Covered by the 0102 view and RPC (UI-1…UI-4 in `tests-0102.sql` use the screen's exact columns, filters and named
parameters). Not covered, not blocking: a server-side TOTAL in pesos for the indicator (the count is server-side; the monthly
total is the P&L line) — an optional `fin_expense_pending_summary` view.

**Proposal (SQL, NOT implemented) — the WhatsApp concept next to a Mercado Pago pending outflow.** A "Registrar sin clasif" of a
Mercado Pago expense writes nothing in the ERP (§19.8); its concept lives in `wa.draft`, which the ERP API cannot read. Proposed
addition to the WhatsApp migration (0101): a read-only view `public.fin_mp_whatsapp_notes` owned by `postgres` (not
security_invoker, so it can read `wa.draft`), `WHERE current_app_role() = 'ADMIN'`, exposing only `source_id`, `draft_short_code`,
`concept`, `confirmed_at` of drafts CONFIRMED with `result.financial_effect = 'EXISTING_MP_OUTFLOW'`; SELECT for `authenticated`.
The MP pending list would show "WhatsApp W-0042: <concept>" on the row and pre-fill the concept of "Clasificar salida". No
movement, no write, no change to the ADR-021 routes. Requires owner approval before implementing.

**Tests (local).** ERP 0102 61/61 (rolled back; UI contract included) and 13/13 concurrency (disposable clone); WhatsApp SQL
124/124 staging + 124/124 candidate; n8n 10/24/17; Edge 14/14; frontend unit 382/382 (new `adr025-unclassified-expenses`:
data layer, filters never injected, RPC-only writes, ADMIN-only module, P&L line not re-added), `tsc -b` clean, `oxlint` with no
warning in the new / changed files.

**Residual risks.** The screen is verified by unit tests and SQL contract tests, not yet by a browser walkthrough against an ERP
with 0102 applied (manual procedure in the delivery). The indicator has no peso total (count only). The Mercado Pago concept
from WhatsApp is not visible in the ERP until the proposal above is approved.

### 19.10 Stage 3 — Mercado Pago WhatsApp notes and browser validation (owner GO 2026-10-23; local)

**`fin_mp_whatsapp_notes` (implemented in the WhatsApp migration 0101 and in `upgrade-004`, not applied).** Read-only view owned
by `postgres` (it reads `wa.draft`), **`security_barrier = true`** (the ADMIN condition is evaluated before any filter or function
of the caller), rows only for an active ADMIN profile of `auth.uid()`, exactly four columns: SOURCE_ID, draft code, concept,
confirmation date — of drafts CONFIRMED with `financial_effect = EXISTING_MP_OUTFLOW` (security review 2026-10-23: the first
version lacked `security_barrier` and exposed amount / date; both corrected before any commit). Tie to the ADR-021 pending:
the SOURCE_ID (one live / confirmed draft per SOURCE_ID — existing unique index `wa_draft_mp_source_once`; one pending outflow per
SOURCE_ID) — no financial contract changed. SELECT only for `authenticated`. Screen: Caja → Pendientes de clasificar shows
"WhatsApp W-…: <concept>" on the row and pre-fills the concept of the existing "Clasificar salida" route (applied when the form
opens). Tests N-1…N-9 (staging 133/133, candidate 133/133): ADMIN reads the note, tied to the same pending, one per SOURCE_ID,
OPERATOR / no-profile JWT 0 rows, anon and service_role refused, no write possible, `security_barrier` and the exact four columns,
no leak to a non-leakproof function in the caller's filter, identity parity with `current_app_role()` in every session context,
nothing financial changed. Identity note: like every RLS policy and RPC of the ERP, the view trusts `auth.uid()`; a SQL session
able to set `request.jwt.*` could impersonate anyone platform-wide — not reachable through the API (PostgREST sets only the signed
JWT claims; `set_config` is not exposed). The WhatsApp migration 0101 DEPENDS ON 0102 (stated in its header).

**Browser walkthrough (disposable stack `adr025_e2e_disposable`, own ports / containers / volumes; app schema copied read-only
from the local ERP — 123 functions, identical fingerprint — plus 0102 → 0101; fictitious data; local test identities; the dev
server verified to point at the disposable API before opening).** PASS: navigation, badge / count 53, filters (account + origin →
8; date range → 5), pagination (2 pages), classification through the RPC (count 53 → 52; Caja chica balance and the ledger — 58
operations / 58 postings — unchanged; purchase on the same payment), P&L before / after (35 000 moved from "Gastos sin
clasificar" to "Costos indirectos", operating result unchanged), two tabs on the same expense (the second shows "ya fue
clasificado", one purchase, no movement), OPERATOR (no Caja; views 0 rows; RPC FORBIDDEN; direct insert 403), Mercado Pago note
and concept pre-fill. Found and fixed during the walkthrough: the concept pre-fill (the note arrives after the row mounts) and
the badge accessible name. The disposable stack was destroyed; the usual local containers, volumes and database are unchanged.
