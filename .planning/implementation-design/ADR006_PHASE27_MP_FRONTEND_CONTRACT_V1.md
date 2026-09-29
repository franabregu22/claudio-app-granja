# ADR-006 — PHASE 27 MERCADO PAGO FRONTEND CONTRACT V1

**Status:** ACCEPTED — Step 14 deliverable (ADR006_IMPLEMENTATION_ORDER_V1 step 14). It covers the Mercado Pago screens of Phase 27 over the **FROZEN** ADR-006 backend contract (Steps 0–13). Decision D-14-1 is RESOLVED (owner, option (a), §9).

**Authority:**
- ADR-006 §6.4 (two axes, terminology) and §8a;
- ADR006_IDEMPOTENCY_AND_STATE_V1 §2.3;
- ADR006_SCHEMA_DELTA_V1 §9, as implemented in 0055;
- ADR006_RPC_CONTRACTS_V1 C1–C7, R1, R2, S5, S6, S7;
- ADR006_RLS_AND_SECURITY_V1 §1;
- ADR-005 (Phase 27 scope).

**Scope.** This is a contract, not an implementation. It fixes the following, and nothing more:
- what the MP screens read;
- which actions they offer;
- which RPC each action calls;
- the labels, states and permissions.

It invents no API wrapper, duplicates no backend state, and does not modify the backend.

The machine-readable block in §10 is the authority for the mechanical check `scripts/regression/adr006-frontend-contract.check.mjs`.

---

## 1. Principles (binding)

1. **Reads.** All MP **state and derived business status** comes exclusively from the three Step-10 views: `report_mp_receipt_status`, `report_mp_delivery_health` and `report_mp_report_exceptions`.
   - The frontend may additionally perform **exactly three** explicitly whitelisted read-only identifier lookups, required by C3, C7 and S7 (§5a). Those lookups are never sources of derived state or business authority.
   - Every other MP read is forbidden: the ADR-005 view `report_mp_movement_status` and any other `mp_*` table read.
   - Non-MP masters may be read as elsewhere in Phase 27. Example: the `clients` list used by a client picker.
2. **Writes.** Every write is one of the authorized RPCs in §5. There is never an INSERT, UPDATE or DELETE on an MP table.
3. **No `register_collection` for an MP receipt.** Client attribution of an MP receipt is only C1 (`mp_allocate_to_client`). An MP receipt never offers "registrar cobro".
4. **Two independent axes.** Axis A (MP reconciliation) and axis B (client attribution) are always shown as **two separate badges**. They are never combined into one status, and neither is ever derived from the other.
5. **No client-side derivation.** `axis_a_state`, `review_reasons`, `axis_b_state`, `effective_applied_receipt` and `active_attributed` are shown as the views return them. The frontend recomputes no state, balance or remaining amount.
6. **No "pending identification balance."** Unattributed receipts are already in the MP balance, so no screen shows or sums a "saldo pendiente de identificar".
7. **CLIENT_UNASSIGNED is a valid terminal state.**
   - It is never a work item, never an error, and never counted as pending.
   - `REPORT_CONFIRMED` + `CLIENT_UNASSIGNED` can stay that way forever and is fully valid.

## 2. Actors

| Actor | MP screens | Behaviour |
|---|---|---|
| ADMIN | all of §3 | reads the views; offers the §5 actions |
| OPERATOR | **none** | the MP navigation entry is not rendered. If an MP route is reached anyway, the views return 0 rows; the screen shows "Sin acceso" and never an empty "all fine" state. Every ADMIN RPC would return `FORBIDDEN` |
| anon | none | no route (permission denied at the database) |

## 3. Screens and panels

| # | Screen / panel | Source view | Rows |
|---|---|---|---|
| S-A | **Actividad MP / cobros recibidos** (list) | `report_mp_receipt_status` | one row per payment / APPROVAL movement |
| S-B | **Detalle del cobro** | `report_mp_receipt_status` (the row of `mp_financial_movement_id`) + `report_mp_report_exceptions` (rows with the same `mp_financial_movement_id`) | 1 (+ its open exceptions) |
| S-C | **Asignar a cliente** (dialog from S-B) | `report_mp_receipt_status` | the selected receipt |
| S-D | **Solicitud de asignación** (flag flow, from S-B) | `report_mp_receipt_status` (`open_flag`, `open_flag_id`) | the selected receipt |
| S-E | **Salud de notificaciones MP** (panel / dashboard banner) | `report_mp_delivery_health` | exactly 1 for ADMIN |
| S-F | **Excepciones de reporte** (list) | `report_mp_report_exceptions` | one per unresolved exception |
| S-G | **Recuperación de consultas** (re-fetch / CONFIG_BLOCKED), from S-E / S-B | `report_mp_delivery_health`, `report_mp_receipt_status` | — |
| S-H | **Avisos de contracargo** (resolution), from S-E | `report_mp_delivery_health` (`unresolved_chargeback_signals`, the count); the signal list comes from lookup L-S7 (§5a), identifiers only | one per unresolved signal |
| S-I | **Mapeo pagador → cliente** | the active-mapping list comes from lookup L-C7 (§5a), identifiers only | one per active mapping |

S-B additionally lists the receipt's allocations, for C3 only, from lookup L-C3 (§5a). This list is for choosing what to reverse and is never used to compute axis B.

**Filters on S-A** (computed server-side by the view; the client only filters):
- axis A state;
- axis B state;
- "requiere revisión" = `axis_a_state = 'REVIEW_REQUIRED'`;
- "solicitudes de asignación" = `axis_b_state = 'CLIENT_RESOLUTION_REQUESTED'`;
- date range on `occurred_date`.

**Work items (the only ones):**
- S-A rows with `axis_a_state = 'REVIEW_REQUIRED'`;
- S-A rows with `axis_b_state = 'CLIENT_RESOLUTION_REQUESTED'`;
- every S-F row;
- S-E when `review_required = true`.

`CLIENT_UNASSIGNED`, `CLIENT_PARTIAL` and `CLIENT_ASSIGNED` are **never** work items.

## 4. Labels

### Axis A — conciliación con Mercado Pago (tesorería)

| `axis_a_state` | Label | Meaning shown |
|---|---|---|
| `NORMALIZED` | En aplicación | the movement exists; the treasury effect is not yet committed (normally seconds) |
| `POSTED` | Acreditado en tesorería MP | the receipt, fee and tax are applied to the MP account |
| `REPORT_CONFIRMED` | Confirmado por reporte MP | posted, plus a MATCHED report row |
| `REVIEW_REQUIRED` | Requiere revisión | one or more of the reasons below |

| `review_reasons[]` | Label |
|---|---|
| `SOURCE_ERROR` | Datos de MP no procesables |
| `DELIVERY_FAILED_PERMANENT` | Consulta a MP agotada |
| `DELIVERY_CONFIG_BLOCKED` | Credencial de MP bloqueada |
| `REPORT_EXCEPTION` | Diferencia con reporte MP |
| `APPLICATION_STUCK` | Aplicación en tesorería demorada |
| `CHARGEBACK_ALERT` | Contracargo informado por MP |
| `MEDIATION_ALERT` | Disputa / mediación abierta en MP |
| `CHARGEBACK_SIGNAL_REFRESH_PENDING` | Aviso de contracargo en verificación |
| `UNAPPLIED_REVERSAL` | Devolución o contracargo sin aplicar |

### Axis B — atribución a cliente (opcional)

| `axis_b_state` | Label | Work item |
|---|---|---|
| `CLIENT_UNASSIGNED` | **Sin cliente asignado** | no |
| `CLIENT_PARTIAL` | **Asignación parcial** | no |
| `CLIENT_ASSIGNED` | **Cliente asignado** | no |
| `CLIENT_RESOLUTION_REQUESTED` | **Asignación solicitada por ADMIN** | yes (the only one) |

Axis B is never labelled with "pendiente", "conciliado", "no conciliado", "sin conciliar" or "error".

### Delivery health (S-E)

| Field / state | Label |
|---|---|
| `received_count` | Recibidas |
| `processing_count` | Procesando |
| `fetched_count` | Consultadas |
| `signal_recorded_count` | Avisos registrados |
| `failed_retryable_count` | Reintentando |
| `failed_permanent_count` | Fallidas (definitivas) |
| `config_blocked_count` | Bloqueadas por credencial |
| `unsupported_count` | Tópicos no soportados |
| `auth_configuration_error` = true | Banner: "Credencial de Mercado Pago inválida o sin permisos — las consultas están en espera" |
| `unresolved_chargeback_signals` > 0 | Avisos de contracargo sin resolver |
| `key_conflicts` > 0 | Notificaciones en conflicto (integración) |

### Report exceptions (S-F)

| `outcome` | Label |
|---|---|
| `DISCREPANCY` | Diferencia con el reporte |
| `MISSING_IN_REPORT` | Falta en el reporte |
| `BALANCE_CHECK` | Diferencia de saldo |

The R1 resolutions are `EXPLAINED` = Explicada, `CORRECTED` = Corregida and `SUPERSEDED` = Reemplazada.

## 5. Actions → RPC (ADMIN only)

Every action:
- requires a non-empty reason typed by the ADMIN;
- shows the RPC's error code verbatim, mapped to a message;
- then re-reads the source view.

For C1 / C3 the idempotency key is generated **once per form submission**, as `ui:<uuid>`. A retry of the same submission reuses it. It never uses the reserved prefixes `MPA:`, `MPAUTO:` or `MPREV:`.

| Id | Action (screen) | RPC | Parameter sources | Availability |
|---|---|---|---|---|
| C1 | Asignar a cliente (S-C) | `mp_allocate_to_client` | movement = `mp_financial_movement_id`; client = client picker; amount ≤ `effective_applied_receipt − active_attributed` (hint only: the RPC enforces the cap); effective date ≥ `occurred_date` | S-B / S-C, when `axis_a_state` ∈ {POSTED, REPORT_CONFIRMED} |
| C3 | Revertir asignación (S-B) | `mp_reverse_client_allocation` | allocation = `id` from L-C3; amount typed by the ADMIN (the RPC enforces REVERSAL_EXCEEDS_ALLOCATION); key `ui:<uuid>` | S-B, when L-C3 returns rows |
| C4 | Solicitar asignación (S-D) | `mp_flag_for_attribution` | movement = `mp_financial_movement_id` | when `open_flag = false` |
| C5 | Cerrar solicitud (S-D) | `mp_clear_attribution_flag` | flag = `open_flag_id` | when `open_flag = true` |
| C6 | Mapear pagador a cliente (S-I) | `mp_map_payer_to_client` | payer id typed by the ADMIN (digits); client = client picker | always (ADMIN) |
| C7 | Quitar mapeo (S-I) | `mp_unmap_payer` | mapping = `id` from L-C7 | S-I, per active mapping |
| R1 | Resolver excepción (S-F) | `mp_resolve_match` | match = `match_id`; resolution ∈ {EXPLAINED, CORRECTED, SUPERSEDED} | every S-F row. `CORRECTED` requires a prior treasury correction (`NO_CORRECTION_FOUND` otherwise); that correction is outside this contract |
| R2 | Crear desde reporte (fallback) | `mp_normalize_report_fallback` | report source id | **disabled until Step 19** (V-4): the RPC answers `V4_NOT_VERIFIED`, and no frozen view exposes `DEFERRED_BACKFILL` rows |
| S5 | Reintentar tras corregir la credencial (S-G) | `mp_requeue_config_blocked` | — | when `auth_configuration_error = true` |
| S6 | Volver a consultar un pago (S-G / S-B) | `mp_request_refetch` | payment id = `payment_id` (S-B) or typed digits (S-G) | always (ADMIN) |
| S7 | Resolver aviso de contracargo (S-H) | `mp_resolve_chargeback_signal` | delivery = `id` from L-S7; resolution ∈ {LINKED + payment id typed by the ADMIN, DISMISSED} | S-H, per unresolved signal |

C2 (`mp_auto_allocate`) is backend-only (service role). Its result is visible only as axis B, and it is never a UI action.

## 5a. Identifier lookups (D-14-1, the only reads outside the Step-10 views)

Each lookup:
- is SELECT only, on a table the ADMIN can already read under the frozen RLS (ADR006_RLS_AND_SECURITY_V1 §1);
- adds no grant, policy or migration;
- returns only the allow-listed columns below, with exactly the stated predicate;
- serves only to obtain the identifier passed to its RPC.

A lookup never derives axis A, axis B, a review state, a balance, a remaining amount, validity or a work item, and it never replaces a Step-10 view.

| Id | Table | Predicate (exact) | Columns exposed (allow-list) | Consuming RPC |
|---|---|---|---|---|
| L-C3 | `mp_client_allocation` | `mp_financial_movement_id = <selected receipt>` AND `origin = 'ALLOCATION'` | `id`, `cliente_id`, `amount`, `mode`, `effective_date` | C3 `mp_reverse_client_allocation(p_allocation_id, …)` |
| L-C7 | `mp_payer_client_map` | `activo = true` | `id`, `mp_payer_id`, `cliente_id`, `created_at` | C7 `mp_unmap_payer(p_mapping_id, …)` |
| L-S7 | `mp_webhook_delivery` | `topic_class = 'chargeback'` AND `status = 'SIGNAL_RECORDED'` AND `signal_resolution IS NULL` | `id`, `resource_id` (the chargeback id), `received_at` | S7 `mp_resolve_chargeback_signal(p_delivery_id, …)` |

The client name is shown through the non-MP `clients` master.

**Never exposed by a lookup:**
- `notification_payload` or any payload / manifest / body;
- `notification_sha256`, `delivery_key` or `x_request_id`;
- headers or signatures;
- `evidence`, `idempotency_key`, `client_ledger_id` or `reason` text;
- claim tokens or leases;
- any secret;
- any delivery row other than an unresolved chargeback signal.

## 6. Loading, empty and review states

| Screen | Loading | Empty (ADMIN) | Review |
|---|---|---|---|
| S-A | skeleton list | "No hay cobros de Mercado Pago en el período" | the REVIEW_REQUIRED badge with the reason labels; the axis-B "Asignación solicitada por ADMIN" badge |
| S-B | skeleton | "Cobro no encontrado" | the reasons listed; open exceptions from S-F inline |
| S-E | skeleton | — (one row always exists for ADMIN) | banner when `review_required` / `auth_configuration_error` |
| S-F | skeleton list | "Sin excepciones abiertas" | every row is review |

- An RPC error keeps the dialog open with the mapped message. The view is re-read after every successful action.
- OPERATOR sees no MP screen (§2).

## 7. Forbidden (explicit)

- `register_collection` on, or offered for, an MP receipt.
- Any INSERT / UPDATE / DELETE on an `mp_*` table, and any direct PostgREST write to one.
- Calling a service-only RPC from the frontend: `mp_register_delivery`, `mp_claim_deliveries`, `mp_delivery_transition`, `mp_ingest_api_snapshot`, `mp_normalize_source`, `mp_apply_transition`, `mp_auto_allocate`, `mp_check_report_coverage`, `mp_record_balance_check`.
- `mp_reconcile_movement` (RPC 41) from these MP screens. Treasury corrections are outside this contract.
- Reading `report_mp_movement_status`, or any `mp_*` table other than through the three §5a lookups, and using a lookup for anything but its RPC's identifier.
- Computing axis states, review reasons, effective receipt, attributed or remaining amounts, or any "saldo pendiente de identificar" on the client.
- A combined single status, or labelling axis B with pendiente / conciliado / no conciliado / sin conciliar / error.
- Treating `CLIENT_UNASSIGNED` (or `CLIENT_PARTIAL`) as a work item.

## 8. Relationship to the backend

- No backend object is created or changed by this contract.
- The backend contract stays FROZEN.
- Steps 16 and 19 (Account Money parser, V-4) are not started. When they land, R2 becomes available, and report-based rows appear in the existing views without any contract change.

## 9. Decision D-14-1 — RESOLVED (owner, option (a))

Three authorized actions take an identifier that no Step-10 view exposes: C3 (`p_allocation_id`), C7 (`p_mapping_id`) and S7 (`p_delivery_id`).

The owner chose option (a): three narrowly scoped, read-only identifier lookups (§5a) on tables the ADMIN can already read. There is no backend change, and the ADR-006 backend stays FROZEN.

Option (b), new view columns or views, was rejected because it would reopen the frozen contract.

The three Step-10 views remain the exclusive source of MP state. C3, C7 and S7 are ACTIVE.

## 10. Machine-readable contract

```json
{
  "contract": "ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1",
  "state_sources": ["report_mp_receipt_status", "report_mp_delivery_health", "report_mp_report_exceptions"],
  "reads": {
    "S-A": {
      "view": "report_mp_receipt_status",
      "fields": ["mp_financial_movement_id", "payment_id", "occurred_date", "gross_amount", "fee_amount", "tax_amount", "net_amount", "axis_a_state", "review_reasons", "axis_b_state", "active_attributed", "effective_applied_receipt", "open_flag"]
    },
    "S-B": {
      "view": "report_mp_receipt_status",
      "fields": ["mp_financial_movement_id", "transition_id", "payment_id", "source_type", "source_processing_status", "latest_snapshot_status", "occurred_date", "gross_amount", "fee_amount", "tax_amount", "net_amount", "assigned_amount", "report_matched", "axis_a_state", "review_reasons", "effective_applied_receipt", "unapplied_reversal_count", "unapplied_reversal_amount", "active_attributed", "axis_b_state", "open_flag", "open_flag_id"]
    },
    "S-B-exceptions": {
      "view": "report_mp_report_exceptions",
      "fields": ["match_id", "outcome", "detail", "created_at", "mp_financial_movement_id"]
    },
    "S-C": {
      "view": "report_mp_receipt_status",
      "fields": ["mp_financial_movement_id", "occurred_date", "axis_a_state", "effective_applied_receipt", "active_attributed"]
    },
    "S-D": {
      "view": "report_mp_receipt_status",
      "fields": ["mp_financial_movement_id", "open_flag", "open_flag_id", "axis_b_state"]
    },
    "S-E": {
      "view": "report_mp_delivery_health",
      "fields": ["total_deliveries", "received_count", "processing_count", "fetched_count", "signal_recorded_count", "failed_retryable_count", "failed_permanent_count", "config_blocked_count", "unsupported_count", "due_count", "oldest_due_at", "failed_permanent_by_error_code", "auth_configuration_error", "config_blocked_oldest", "key_conflicts", "unresolved_chargeback_signals", "review_required"]
    },
    "S-F": {
      "view": "report_mp_report_exceptions",
      "fields": ["match_id", "outcome", "report_source_type", "report_external_id", "transition_id", "resource_type", "resource_id", "transition", "mp_financial_movement_id", "coverage_from", "coverage_to", "detail", "created_at", "axis_a_state"]
    },
    "S-G": {
      "view": "report_mp_delivery_health",
      "fields": ["auth_configuration_error", "config_blocked_count", "config_blocked_oldest", "failed_permanent_count", "failed_permanent_by_error_code"]
    },
    "S-H": {
      "view": "report_mp_delivery_health",
      "fields": ["unresolved_chargeback_signals"]
    }
  },
  "lookups": [
    {
      "id": "L-C3",
      "for_action": "C3",
      "table": "mp_client_allocation",
      "operation": "SELECT",
      "predicate": {
        "mp_financial_movement_id": ":selected_receipt",
        "origin": "ALLOCATION"
      },
      "columns": ["id", "cliente_id", "amount", "mode", "effective_date"],
      "rpc_param": "p_allocation_id"
    },
    {
      "id": "L-C7",
      "for_action": "C7",
      "table": "mp_payer_client_map",
      "operation": "SELECT",
      "predicate": {
        "activo": true
      },
      "columns": ["id", "mp_payer_id", "cliente_id", "created_at"],
      "rpc_param": "p_mapping_id"
    },
    {
      "id": "L-S7",
      "for_action": "S7",
      "table": "mp_webhook_delivery",
      "operation": "SELECT",
      "predicate": {
        "topic_class": "chargeback",
        "status": "SIGNAL_RECORDED",
        "signal_resolution": null
      },
      "columns": ["id", "resource_id", "received_at"],
      "rpc_param": "p_delivery_id"
    }
  ],
  "actions": [
    {
      "id": "C1",
      "rpc": "mp_allocate_to_client",
      "args": "p_movement_id bigint, p_cliente_id uuid, p_amount numeric, p_effective_date date, p_idempotency_key character varying, p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "C3",
      "rpc": "mp_reverse_client_allocation",
      "args": "p_allocation_id uuid, p_amount numeric, p_idempotency_key character varying, p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "C4",
      "rpc": "mp_flag_for_attribution",
      "args": "p_movement_id bigint, p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "C5",
      "rpc": "mp_clear_attribution_flag",
      "args": "p_flag_id uuid, p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "C6",
      "rpc": "mp_map_payer_to_client",
      "args": "p_mp_payer_id character varying, p_cliente_id uuid, p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "C7",
      "rpc": "mp_unmap_payer",
      "args": "p_mapping_id uuid, p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "R1",
      "rpc": "mp_resolve_match",
      "args": "p_match_id uuid, p_resolution character varying, p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "R2",
      "rpc": "mp_normalize_report_fallback",
      "args": "p_source_record_id uuid, p_reason text",
      "availability": "DISABLED_UNTIL_STEP_19"
    },
    {
      "id": "S5",
      "rpc": "mp_requeue_config_blocked",
      "args": "p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "S6",
      "rpc": "mp_request_refetch",
      "args": "p_payment_id character varying, p_reason text",
      "availability": "ACTIVE"
    },
    {
      "id": "S7",
      "rpc": "mp_resolve_chargeback_signal",
      "args": "p_delivery_id uuid, p_resolution character varying, p_payment_id character varying, p_reason text",
      "availability": "ACTIVE"
    }
  ],
  "axis_a_labels": {
    "NORMALIZED": "En aplicación",
    "POSTED": "Acreditado en tesorería MP",
    "REPORT_CONFIRMED": "Confirmado por reporte MP",
    "REVIEW_REQUIRED": "Requiere revisión"
  },
  "review_reason_labels": {
    "SOURCE_ERROR": "Datos de MP no procesables",
    "DELIVERY_FAILED_PERMANENT": "Consulta a MP agotada",
    "DELIVERY_CONFIG_BLOCKED": "Credencial de MP bloqueada",
    "REPORT_EXCEPTION": "Diferencia con reporte MP",
    "APPLICATION_STUCK": "Aplicación en tesorería demorada",
    "CHARGEBACK_ALERT": "Contracargo informado por MP",
    "MEDIATION_ALERT": "Disputa / mediación abierta en MP",
    "CHARGEBACK_SIGNAL_REFRESH_PENDING": "Aviso de contracargo en verificación",
    "UNAPPLIED_REVERSAL": "Devolución o contracargo sin aplicar"
  },
  "axis_b_labels": {
    "CLIENT_UNASSIGNED": "Sin cliente asignado",
    "CLIENT_PARTIAL": "Asignación parcial",
    "CLIENT_ASSIGNED": "Cliente asignado",
    "CLIENT_RESOLUTION_REQUESTED": "Asignación solicitada por ADMIN"
  },
  "work_items": [
    {
      "view": "report_mp_receipt_status",
      "where": {
        "axis_a_state": "REVIEW_REQUIRED"
      }
    },
    {
      "view": "report_mp_receipt_status",
      "where": {
        "axis_b_state": "CLIENT_RESOLUTION_REQUESTED"
      }
    },
    {
      "view": "report_mp_report_exceptions",
      "where": {}
    },
    {
      "view": "report_mp_delivery_health",
      "where": {
        "review_required": true
      }
    }
  ],
  "forbidden_rpcs": ["register_collection", "mp_reconcile_movement", "mp_register_delivery", "mp_claim_deliveries", "mp_delivery_transition", "mp_ingest_api_snapshot", "mp_normalize_source", "mp_apply_transition", "mp_auto_allocate", "mp_check_report_coverage", "mp_record_balance_check"],
  "forbidden_reads": ["report_mp_movement_status", "mp_webhook_delivery", "mp_transition_identity", "mp_report_match", "mp_client_allocation", "mp_payer_client_map", "mp_attribution_flag", "mp_source_record", "mp_financial_movement", "mp_reconciliation"],
  "forbidden_reads_note": "mp_client_allocation, mp_payer_client_map and mp_webhook_delivery are readable only through the lookups L-C3, L-C7, L-S7; never for state",
  "table_writes": []
}
```
