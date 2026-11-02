/** Lote 5 (ADR-027, 0112) — declared Mercado Pago collections: transport, reading, the modal and the routes that no longer discount a client. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { rectifyDeclaredCollection, registerDeclaredCollection, reverseDeclaredCollection } from '../../src/target/commercial';
import {
  canAnnulMpAllocation, canReverseDeclaredCollection, canReverseManualCollection, COLLECTION_ORIGIN_LABEL, COLLECTION_STATUS_LABEL, collectionIdOf, collectionTotals,
  type CustomerCollectionRow, declaredIdOf, DECLARED_LABEL, groupCustomerCollections,
} from '../../src/target/customerCollections';
import { TARGET_RPCS } from '../../src/target/db';
import { errorMessage } from '../../src/target/messages';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const ID = '0b6c1f7e-3d2a-4c1b-9f00-1234567890ab';
const fila = (p: Partial<CustomerCollectionRow>): CustomerCollectionRow => ({
  row_id: `D:${ID}`, business_date: '2026-11-02', created_at: '2026-11-02T10:00:00Z', cliente_id: 'c1', client_name: 'Cliente', amount: 1000, account_name: 'Mercado Pago',
  account_type: 'DECLARED', payment_method: 'MERCADOPAGO', notes: null, financial_operation_id: null, source_id: null, origin: 'DECLARED_MP', status: 'DECLARED', correction_id: null,
  correction_role: 'SINGLE', counts_for_customer: true, reversal_kind: null, reversal_reason: null, reversal_at: null, replacement_of: null, sales_session_id: null, registered_by: null, reversal_by: null, ...p,
});

function rpcClient() {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ path: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ replayed: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}

describe('Lote 5 — declared collections: transport', () => {
  it('register sends client, amount, date, note and key, and no account or movement', async () => {
    const { client, seen } = rpcClient();
    await registerDeclaredCollection(client, { clienteId: 'c1', amount: 1500.5, effectiveDate: '2026-11-02', note: '  transferencia  ', idempotencyKey: 'ui:1' });
    expect(seen[0].path).toBe('/rest/v1/rpc/register_declared_collection');
    expect(seen[0].body).toEqual({ p_cliente_id: 'c1', p_amount: 1500.5, p_effective_date: '2026-11-02', p_note: 'transferencia', p_idempotency_key: 'ui:1' });
  });

  it('a blank note is no note', async () => {
    const { client, seen } = rpcClient();
    await registerDeclaredCollection(client, { clienteId: 'c1', amount: 1, effectiveDate: '2026-11-02', note: '   ', idempotencyKey: 'ui:2' });
    expect(seen[0].body.p_note).toBeNull();
  });

  it('annul and rectify send only what they change', async () => {
    const { client, seen } = rpcClient();
    await reverseDeclaredCollection(client, { id: ID, reason: 'error', idempotencyKey: 'ui:3' });
    await rectifyDeclaredCollection(client, { id: ID, clienteId: 'c2', amount: 900, effectiveDate: '2026-11-01', reason: 'error', idempotencyKey: 'ui:4' });
    expect(seen[0]).toEqual({ path: '/rest/v1/rpc/reverse_declared_collection', body: { p_id: ID, p_reason: 'error', p_idempotency_key: 'ui:3' } });
    expect(seen[1].path).toBe('/rest/v1/rpc/rectify_declared_collection');
    expect(Object.keys(seen[1].body).sort()).toEqual(['p_amount', 'p_cliente_id', 'p_effective_date', 'p_id', 'p_idempotency_key', 'p_reason']);
  });

  it('the three RPCs are allow-listed; the old ones stay', () => {
    expect(TARGET_RPCS).toEqual(expect.arrayContaining(['register_declared_collection', 'reverse_declared_collection', 'rectify_declared_collection', 'mp_allocate_to_client', 'mp_classify_inflow_as_collection', 'mp_map_payer_to_client']));
  });
});

describe('Lote 5 — declared collections: reading', () => {
  it('the exact label, everywhere', () => {
    expect(DECLARED_LABEL).toBe('Cobro declarado · Sin conciliación individual');
    expect(COLLECTION_STATUS_LABEL.DECLARED).toBe(DECLARED_LABEL);
    expect(COLLECTION_ORIGIN_LABEL.DECLARED_MP).toBe('Declarado');
  });

  it('the row id says what a row is', () => {
    expect(declaredIdOf(fila({}))).toBe(ID);
    expect(declaredIdOf(fila({ row_id: `C:${ID}` }))).toBeNull();
    expect(collectionIdOf(fila({}))).toBeNull();
  });

  it('annul / rectify: only a live declaration, never the money routes', () => {
    expect(canReverseDeclaredCollection(fila({}))).toBe(true);
    expect(canReverseDeclaredCollection(fila({ reversal_kind: 'ANNUL', counts_for_customer: false }))).toBe(false);
    expect(canReverseDeclaredCollection(fila({ row_id: `C:${ID}`, origin: 'CASH' }))).toBe(false);
    expect(canReverseManualCollection(fila({}))).toBe(false);
    expect(canAnnulMpAllocation(fila({}))).toBe(false);
  });

  it('Caja: a declaration is never money; an annulled original counts for nothing', () => {
    const rows = [fila({ row_id: `C:${ID}`, origin: 'CASH', account_type: 'CASH', amount: 700, financial_operation_id: 9 }), fila({ amount: 300 }),
      fila({ row_id: 'D:other', amount: 50, reversal_kind: 'ANNUL', counts_for_customer: false, status: 'ANNULLED' })];
    expect(collectionTotals(groupCustomerCollections(rows))).toEqual({ dinero: 700, declarado: 300 });
    expect(SRC('features/caja/CobrosClientes.tsx')).toMatch(/cobrado en dinero .*declarados, sin movimiento de dinero/);
  });

  it('the refusal of the old routes explains the new one', () => {
    expect(errorMessage({ message: 'MP_CLIENT_ALLOCATION_DISABLED: x' })).toMatch(/cobro declarado/);
    expect(errorMessage({ message: 'MP_PAYER_MAP_DISABLED: x' })).toMatch(/se declaran/);
  });
});

describe('Lote 5 — Registrar cobro', () => {
  const modal = SRC('features/cobros/RegistroPagoModal.tsx');

  it('Mercado Pago: amount, date and note, no movement to search; the label is shown', () => {
    expect(existsSync(resolve(__dirname, '../../src/features/cobros/BuscadorCobroMp.tsx'))).toBe(false);
    expect(modal).toMatch(/useRegisterDeclaredCollection/);
    expect(modal).toMatch(/\{DECLARED_LABEL\}/);
    expect(modal).toMatch(/esMp \? 'Medio de cobro' : 'Cuenta donde entra el dinero'/);   // on Mercado Pago no money enters here
    expect(modal).not.toMatch(/\{!esMp && <label/);   // amount and date for every account
    expect(modal).not.toMatch(/candidatosMp|useCobrosMp|elegidoMp|Disponible MP/);
  });

  it('cash and bank keep register_collection; advances keep their confirmation', () => {
    expect(modal).toMatch(/registrar\.mutate\(\{\n\s+clienteId: cliente\.cliente_id, amount: montoNum, method: metodo, receiptId: claveAuto/);
    expect(modal).toMatch(/const creditoOk = !generaCredito \|\| creditoConfirmado === resultante;/);
  });

  it('one idempotency key per opened form, on both routes', () => {
    expect(modal).toMatch(/idempotencyKey: `ui:\$\{claveAuto\}`/);
    expect(modal).toMatch(/receiptId: claveAuto/);
  });

  it('the history offers Anular and Rectificar on a declaration, with the label', () => {
    const t = SRC('features/cobros/TablaCobros.tsx');
    expect(t).toMatch(/canReverseDeclaredCollection\(p\)/);
    expect(t).toMatch(/\{DECLARED_LABEL\}/);
    expect(t).toMatch(/<AnularCobroDeclaradoModal /);
    expect(t.indexOf('canReverseDeclaredCollection(p) &&')).toBeLessThan(t.indexOf("p.origin === 'DECLARED_MP' && <span"));   // mobile: the actions stay visible, the label goes below
    expect(t).toMatch(/<RectificarCobroDeclaradoModal /);
  });

  it('annul and rectify require a reason', () => {
    const t = SRC('features/cobros/CobroDeclaradoModales.tsx');
    expect(t.match(/motivo\.trim\(\) !== ''/g)?.length).toBe(2);
    expect(t).not.toMatch(/accountId|financial_account|useFinancialAccounts/);   // a declaration has no account
  });
});

describe('Lote 5 — no double discount', () => {
  it('Cuentas corrientes never reaches a Mercado Pago allocation', () => {
    expect(SRC('features/caja/MovimientoMp.tsx')).not.toMatch(/useAsignarCobroMp|allocateToClient|listReceipts/);
  });

  it('Entradas sin vincular: no client link, no "Recordar este pagador"; the own-account route stays', () => {
    const t = SRC('features/caja/EntradasSinVincular.tsx');
    expect(t).not.toMatch(/useLinkInflow|useRememberPayer|VincularCliente|Recordar este pagador/);
    expect(t).toMatch(/Transferencia desde cuenta propia/);
    expect(SRC('features/caja/useMpActivity.ts')).not.toMatch(/mapPayerToClient|allocateToClient/);
  });

  it('Mercado Pago → Cobros: no assignment, no assignment request; reverting history stays', () => {
    const t = SRC('features/mercadopago/CobrosMP.tsx');
    expect(t).not.toMatch(/Asignar a cliente|AsignarModal|Solicitar asignación/);
    expect(t).toMatch(/Revertir asignación/);
  });

  it('Pagadores: no new mapping; removing an existing one stays', () => {
    const t = SRC('features/mercadopago/OperacionesMP.tsx');
    expect(t).not.toMatch(/Mapear pagador|mapPayerToClient/);
    expect(t).toMatch(/Quitar mapeo/);
  });

  it('classifying an inflow names no client, and the hook cannot send one', () => {
    const s = SRC('features/caja/CuentaDetalle.tsx');
    const ingreso = s.slice(s.indexOf('function ClasificarIngreso'));
    expect(ingreso).toMatch(/collection\.mutate\(\{ paymentId \}\)/);
    expect(ingreso).not.toMatch(/useClients|aria-label="Cliente"/);
    expect(SRC('features/caja/useMpActivity.ts')).toMatch(/classifyMpInflowAsCollection\(supabase, i\.paymentId, null\)/);
  });
});
