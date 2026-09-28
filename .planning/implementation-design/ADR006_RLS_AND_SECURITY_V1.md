# ADR-006 RLS AND SECURITY V1

**Status:** implementation design. **Authority:** RLS_IMPLEMENTATION_SPEC_V1 (§2, §4, §9, §10, verification queries 6/6b/7/8), DATABASE_INVARIANTS_V1 (9, 21), 0041, ADR-006 §9.

---

## 1. Actors

| Actor | Identity | ADR-006 capabilities |
|---|---|---|
| `anon` | no JWT | **nothing**: no table grant, no function EXECUTE |
| `authenticated` ADMIN | `current_app_role() = 'ADMIN'` | read the new tables and views; the attribution, flag, payer-map, match-resolution and report-fallback RPCs; RPC 41 (existing) |
| `authenticated` OPERATOR | `current_app_role() = 'OPERATOR'` | **nothing**: no policy on any MP table, and every ADMIN RPC raises `FORBIDDEN`. Views return 0 rows |
| `service_role` | `auth.role() = 'service_role'` | the delivery RPCs, snapshot ingest, RPC 40, A1, C2, R3, R4; SELECT on the queue, source, movement, identity and match tables; report-row INSERT on `mp_source_record` (narrowed) |
| `postgres` | owner | owns every function (SECURITY DEFINER runs as owner) |
| Public webhook caller (MP or attacker) | HTTP only | no database identity at all; the Edge Function decides and uses one RPC |

---

## 2. Table privileges and policies (0051)

The pattern is the same as 0041: `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, then narrow grants. RLS is enabled on every table. There are no INSERT, UPDATE or DELETE grants for application roles on any new table: all writes go through SECURITY DEFINER RPCs.

| Table | authenticated grant | Policies | service_role grant | Policies |
|---|---|---|---|---|
| `mp_webhook_delivery` | SELECT | `mp_delivery_admin_select USING (current_app_role() = 'ADMIN')` | SELECT | `mp_delivery_service_select USING (auth.role() = 'service_role')` |
| `mp_transition_identity` | SELECT | admin select | SELECT | service select |
| `mp_report_match` | SELECT | admin select | SELECT | service select |
| `mp_client_allocation` | SELECT | admin select | **none** | — |
| `mp_payer_client_map` | SELECT | admin select | **none** | — |
| `mp_attribution_flag` | SELECT | admin select | **none** | — |
| `mp_source_record` (amended policy) | unchanged | unchanged | INSERT, SELECT unchanged | `mp_source_service_insert WITH CHECK (auth.role() = 'service_role' AND source_type IN ('csv_import','account_money_csv'))` replaces the 0041 policy (R4). `api_payment` / `api_refund` rows are created only by SECURITY DEFINER RPCs |

- Sequences: `REVOKE ALL ON SEQUENCE mp_transition_identity_id_seq FROM PUBLIC, anon, authenticated, service_role`.
- `DATABASE_INVARIANTS_V1` invariant 9 (append-only list) gains `mp_transition_identity` and `mp_client_allocation`, recorded by ADR-006.
- The controlled-mutable exceptions gain `mp_webhook_delivery` (queue columns), `mp_report_match` (resolution, once), `mp_payer_client_map` (deactivation, once) and `mp_attribution_flag` (clear, once). Each is protected by an absent UPDATE privilege plus a guard trigger where immutable columns exist.

---

## 3. Function EXECUTE grants

`REVOKE ALL ON FUNCTION … FROM PUBLIC, anon` for all of them. In addition:

| Function | EXECUTE granted to | In-body actor check |
|---|---|---|
| `mp_register_delivery` | service_role | `auth.role() = 'service_role'` |
| `mp_claim_deliveries` | service_role | same |
| `mp_delivery_transition` | service_role | same |
| `mp_requeue_config_blocked` | authenticated, service_role | ADMIN or `auth.role() = 'service_role'` |
| `mp_ingest_api_snapshot` | service_role | same |
| `mp_normalize_source` (RPC 40, redefined) | service_role (unchanged) | same (unchanged) |
| `mp_apply_transition` | service_role | same |
| `mp_auto_allocate` | service_role | same |
| `mp_check_report_coverage` | service_role | same |
| `mp_record_balance_check` | service_role | same |
| `mp_reconcile_movement` (RPC 41, redefined) | authenticated, service_role (unchanged) | ADMIN or service (unchanged) |
| `mp_allocate_to_client` | authenticated | ADMIN |
| `mp_reverse_client_allocation` | authenticated | ADMIN |
| `mp_flag_for_attribution` | authenticated | ADMIN |
| `mp_clear_attribution_flag` | authenticated | ADMIN |
| `mp_map_payer_to_client` | authenticated | ADMIN |
| `mp_unmap_payer` | authenticated | ADMIN |
| `mp_resolve_match` | authenticated | ADMIN |
| `mp_normalize_report_fallback` | authenticated | ADMIN |
| `mp_request_refetch` | authenticated | ADMIN |
| `mp_resolve_chargeback_signal` | authenticated | ADMIN |
| `mp_is_auto_applicable` (STABLE), `mp_v4_verified` (IMMUTABLE), `mp_parse_report_row` and `mp_claim_report_payment_fallback`; all four helpers are SECURITY **INVOKER** | none beyond the owner (`REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`) | — called only inside definer functions. `mp_claim_report_payment_fallback` is called only by `mp_normalize_report_fallback` |
| `mp_delivery_immutable_guard`, `mp_report_match_guard` (trigger functions, SECURITY INVOKER) | none (`REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`), as 0039 does | — |

**Hardening, identical to RLS spec §2:**
- `SECURITY DEFINER`, `SET search_path = public`, `OWNER TO postgres`;
- no dynamic SQL built from parameters;
- every table reference is unqualified under the pinned search_path, and schema-qualified where it is outside `public` (`auth.role()`, `auth.uid()`).

---

## 4. SECURITY DEFINER inventory change (R5)

**Verified current baseline (mechanical, 2026-09-27).** A scan of every `CREATE [OR REPLACE] FUNCTION` in `supabase/target-migrations/0001–0046` gives the distinct names by their final definition: **41 SECURITY DEFINER** and 2 SECURITY INVOKER (`mp_source_raw_guard`, `reject_line_on_used_formula_version`). The 41 are:

`assert_period_open, assign_flock_feed, assign_freight_to_purchase, cancel_order, cancel_supplier_instrument, clear_cheque, close_sales_session, current_app_role, deliver_order, deposit_cheque, endorse_cheque, issue_supplier_instrument, mark_supplier_instrument_debited, mp_normalize_source, mp_reconcile_movement, open_sales_session, pay_fiscal_obligation, pay_supplier, receive_cheque, rectify_daily_production, rectify_delivered_order, rectify_mortality, rectify_purchase, register_classification, register_collection, register_count_adjustment, register_daily_production, register_feed_inventory_count, register_feed_manufacturing, register_feed_movement, register_fiscal_document, register_fiscal_obligation, register_freight, register_management_event, register_mortality, register_purchase, register_session_cash_event, register_session_movement, reject_cheque, reject_supplier_instrument, transfer_between_accounts`

The RLS spec's "43" is the frozen design count (`current_app_role` + 42 RPCs). It is not the implemented baseline and is not used as one.

**New SECURITY DEFINER functions (19)**, none of which is in the 41 above:

`mp_register_delivery, mp_claim_deliveries, mp_delivery_transition, mp_requeue_config_blocked, mp_request_refetch, mp_resolve_chargeback_signal, mp_ingest_api_snapshot, mp_apply_transition, mp_allocate_to_client, mp_auto_allocate, mp_reverse_client_allocation, mp_flag_for_attribution, mp_clear_attribution_flag, mp_map_payer_to_client, mp_unmap_payer, mp_resolve_match, mp_normalize_report_fallback, mp_check_report_coverage, mp_record_balance_check`

- The two sets are disjoint: every new name starts with `mp_`, and the only `mp_` names in the baseline are `mp_normalize_source` and `mp_reconcile_movement`, which are **redefined, not added**. The union is 41 + 19 = **60**.
- ADR-006 adds 19, not 17. Two ADMIN RPCs are required by the corrected design: `mp_request_refetch` (recovery of `FAILED_PERMANENT` payments) and `mp_resolve_chargeback_signal` (linking or dismissing chargeback signals).
- **Test S-7 asserts the exact set** (`SELECT array_agg(proname ORDER BY proname) … WHERE prosecdef` = the 60-name literal list above), not only the count. At implementation time the baseline is **re-enumerated first**; if it differs from the 41 listed, the test literal is corrected from the enumeration, never by arithmetic.
- The Frozen RLS spec is not edited; ADR-006 is the cited authority.

---

## 5. Service-role boundary (Phase 23 I6)

The service role gains **no** table grant on `clients`, `client_ledger`, `pedidos` or any ledger. Its only client-side effects run inside two definer functions, and in both the client, amount and order are derived from stored evidence:
- `mp_auto_allocate`: the client comes from `external_reference` or the active payer map; the amount is the effective receipt; there is no parameter to choose them (OD-2);
- `mp_apply_transition` OD-1 unwinding: the amount is min(R, active), in the deterministic order (OD-1).

The test matrix proves that the service role cannot allocate to an arbitrary client (S-6) and cannot write `client_ledger` directly (S-4).

---

## 6. Public webhook boundary

- `verify_jwt = false` applies only to `mp-webhook` and `mp-worker`.
  - `mp-webhook` authenticates MP by HMAC (V-1).
  - `mp-worker` authenticates its caller by `WORKER_INVOKE_SECRET`; unknown callers get 401 with nothing done.
- Neither function exposes database access to its caller. Each performs a fixed sequence of RPC calls with the server-side key.
- `anon`'s PostgREST access to the new objects is none (§2 and §3), which is verified by test S-1.

---

## 7. Secrets

Covered in ADR006_WEBHOOK_WORKER_DESIGN_V1 §7:
- Edge Function secrets plus Vault only;
- nothing in git, migrations, the database, the frontend or logs;
- the test environment uses fake secrets and a mocked MP API;
- the pre-commit secret scan used for earlier baselines extends to the patterns `MP_ACCESS_TOKEN`, `APP_USR-`, `TEST-` tokens and the webhook secret variable names.

---

## 8. Audit

- **Every business fact** written by an ADR-006 RPC produces exactly one `audit_events` row per fact (the action list is in ADR006_RPC_CONTRACTS_V1 §0):
  - `performed_by` = the ADMIN uid, or NULL for the service role;
  - no payload, token or payer data is stored in `after_values`, only ids, amounts, statuses and codes.
- **Queue mechanics** (claim, retry, lease) are not audited; the delivery row is their record.
- **Completeness is tested** (A-1..A-3 in the test matrix):
  - every allocation, reversal, application, flag, map, resolution, fallback and check has exactly one audit row;
  - the no-op replays (`ALREADY_APPLIED`, `ALREADY_ALLOCATED`, duplicate delivery) add none.
