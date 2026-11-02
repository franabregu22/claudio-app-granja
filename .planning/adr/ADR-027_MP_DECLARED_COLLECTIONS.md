# ADR-027 — Cobros declarados de Mercado Pago: la cuenta corriente sin vínculo con el movimiento

**STATUS:** **ACCEPTED** (owner GO "LOTE 5: COBROS DECLARADOS DE MERCADO PAGO", 2026-11-02). Implemented by migration 0112, not applied.
**DATE:** 2026-11-02
**AMENDS:** Meta A (0091) in one point only — "a client collection in Mercado Pago is the allocation of a real movement" (`mp_allocate_to_client`,
ADR-006 C1). The global SOURCE_ID invariant (0091) stands: a declared collection does not move Mercado Pago, so it needs no source.
Replaces, as the way to record new collections, ADR-023 §"customer linking" and the ADR-024 §6 "Recordar este pagador" control.
**NOT AFFECTED:** cash and bank collections (`register_collection`, 0108), Feria, cheques, every historical collection and allocation, the Mercado
Pago import, ADR-021 / ADR-022, the P&L, the period-close rules, ADR-018 bank reconciliation.

---

## 1. Problem

Finding one Mercado Pago movement for every client payment takes longer than the information is worth. The money is already in the ERP through
the usual import; what is missing is only that the client's debt goes down.

## 2. Decision

1. **Declared collection.** With account = Mercado Pago, "Registrar cobro" asks for amount, date and an optional note. It writes one `client_ledger`
   COLLECTION (−amount) and one `declared_collection`. It writes no `financial_operation`, no `financial_posting` and nothing in any `mp_*` table:
   the Mercado Pago balance does not change. Shown as **"Cobro declarado · Sin conciliación individual"**.
2. **Advances.** As every collection, it may leave the client with a credit (negative balance), after the existing explicit confirmation.
3. **Annul / rectify.** Append-only, by compensation in `client_ledger` (REVERSAL +amount at the original date), reason required, audited, idempotent,
   one effective reversal per declaration, refused in a closed period. A rectification is the reversal plus a new declaration in one transaction. A
   declaration that turns out to be cash or bank is annulled and registered through its real route.
4. **Separate tables.** `collections` is not reused: it requires a financial account, `collection_reversal` requires a financial operation, and a
   collection on the Mercado Pago account is a target of `mp_correct_manual_collection`, which debits Mercado Pago.
5. **Reading.** `fin_customer_collections` appends them as origin `DECLARED_MP`, `account_type = 'DECLARED'`, no operation. Caja → Cobros de clientes
   keeps them out of its money total and shows them apart.
6. **No double discount.** A new manual client allocation of a Mercado Pago movement is refused by the database (`MP_CLIENT_ALLOCATION_DISABLED`): that
   covers `mp_allocate_to_client` and `mp_classify_inflow_as_collection` with a client. The classification without a client stays available. The UI no
   longer offers: assign to a client (Mercado Pago → Cobros), link an inflow to a client (Entradas sin vincular), name a client when classifying an inflow
   (Clasificar ingreso), request an assignment, "Recordar este pagador", map a payer.
7. **No new association.** The database refuses a new payer mapping, reactivating one and pointing one to another client or payer
   (`MP_PAYER_MAP_DISABLED`), through any route. Deactivating a mapping and every historical row stay.

## 3. What stays, and why

- **`mp_auto_allocate` and the worker** are not changed: refusing them would abort the worker's item and retry it forever. On 2026-11-02 production had 0
  mappings, 0 AUTO allocations and 0 payments with an `external_reference`, so it allocates nothing, and `trg_mp_payer_client_map_guard` keeps it that way
  for payers.
- **Its other evidence remains (known limit):** a payment whose `external_reference` is exactly `GST:C:<uuid>` or `GST:P:<uuid>` would still allocate AUTO. Nothing
  in the ERP creates such a reference; a client paying by transfer cannot set one. Closing it needs a change to `mp_auto_allocate`, out of this decision.
- **Reversals of existing allocations** stay (`mp_reverse_client_allocation`): history is corrected as before.
- **`mp_correct_manual_collection`** stays allowed: it re-expresses a client collection that already counted, net zero on the client.
- **Old RPCs are not removed:** `mp_allocate_to_client`, `mp_classify_inflow_as_collection`, `mp_map_payer_to_client` keep their signature and contract; the two guards refuse what no longer applies.
- **Period close:** only unresolved outflows block it (ADR-023, 0095). An inflow never needs a classification to close, so nothing here touches it.

## 4. Testing the old routes

`scripts/target-db/fin_declared_collections.test.mjs` proves the guard. Older suites that exercise a manual allocation (mp_realtime, mp_atomic_application,
mp_worker, mp_views, fin_mp_classify, fin_mp_unlinked_inflows, fin_collection_correction) or a new mapping (fin_mp_payer_privacy) are expected to stop at `MP_CLIENT_ALLOCATION_DISABLED` / `MP_PAYER_MAP_DISABLED`, and an aborted
run can leave fixture rows behind. To regress them, on the local test database only: `DISABLE TRIGGER` `trg_mp_client_allocation_manual_guard` and
`trg_mp_payer_client_map_guard`, run them, then `ENABLE TRIGGER`.

## 5. Consequences

- A declaration is not evidence that the money arrived: nothing compares it with Mercado Pago. The control is human.
- Unlinked inflows and receipts without a client are now permanent by design, not a to-do list.
- The sum of declarations and the Mercado Pago receipts of a period will not match line by line (fees, taxes, payments of third parties, timing).
