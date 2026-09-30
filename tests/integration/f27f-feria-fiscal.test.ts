/**
 * F27-F integration: Feria sales sessions and fiscal records through the frontend data layer
 * (src/target/{feria,fiscal}.ts) against the guarded LOCAL stack only (127.0.0.1, local demo keys read from the
 * running container). The session cash reconciliation is read from report_feria_session_cash; Feria and fiscal are
 * ADMIN-only (ADR-009: OPERATOR is refused on RPCs 30–33 and every fiscal RPC); nothing is written directly.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { TargetDbError, writeTable } from '../../src/target/db';
import { createMaster } from '../../src/target/masters';
import { listLedgerBalances } from '../../src/target/treasury';
import {
  closeSalesSession, listSessionCash, listSessionMovements, listSessions, openSalesSession, registerSessionCashEvent, registerSessionMovement,
} from '../../src/target/feria';
import {
  firstOfMonth, listFiscalDocuments, listObligations, payFiscalObligation, registerFiscalDocument, registerFiscalObligation,
} from '../../src/target/fiscal';

const LOCAL_URL = 'http://127.0.0.1:54321';
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);

function localKeys(): { anon: string; service: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_edge_runtime', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '')
    .trim().split('\n')[0];
  if (!c) throw new Error('local edge-runtime container not running');
  const env = (spawnSync('docker', ['inspect', c, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).stdout || '')
    .split(/\r?\n/);
  const get = (k: string) => (env.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
  const keys = { anon: get('SUPABASE_ANON_KEY'), service: get('SUPABASE_SERVICE_ROLE_KEY') };
  for (const [want, jwt] of [['anon', keys.anon], ['service_role', keys.service]] as const) {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
    if (payload.iss !== 'supabase-demo' || payload.role !== want) throw new Error(`not a local demo ${want} key`);
  }
  return keys;
}
function owner(sql: string): string {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
}

const keys = localKeys();
const service = createClient(LOCAL_URL, keys.service, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const TAG = `F27F-${run}`;
const password = `F27f-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27f-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27f-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const denied = (e: unknown) => e instanceof TargetDbError && ['PERMISSION_DENIED', 'RLS_DENIED', 'FORBIDDEN'].includes(e.code);
const fx = { cash: '', bank: '', category: '', product: '', supplier: '', client: '', today: '' };
const obligations: string[] = [];
// fiscal obligations are unique per (tax kind, fiscal period) in the whole database and need an existing period:
// use an open management period that has no IIBB obligation yet (chosen in beforeAll)
let FAR_PERIOD = '';

const TS = `(SELECT id FROM sales_session WHERE location LIKE '${TAG}%')`;
const TP = `(SELECT id FROM pedidos WHERE sales_session_id IN ${TS})`;
function cleanup() {
  const obl = obligations.length ? `(${obligations.map((o) => `'${o}'`).join(',')})` : `(NULL::UUID)`;
  owner(`
CREATE TEMP TABLE _o AS
  SELECT id FROM financial_operation WHERE source_entity_type = 'sales_session' AND source_entity_id IN (SELECT id::TEXT FROM ${TS} s)
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'fiscal_obligation' AND source_entity_id IN (SELECT id::TEXT FROM fiscal_obligation WHERE id IN ${obl})
  UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN (SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%');
UPDATE sales_session SET aggregated_pedido_id = NULL WHERE id IN ${TS};
DELETE FROM audit_events WHERE entity_type = 'pedido' AND entity_id IN (SELECT id::TEXT FROM ${TP} p);
DELETE FROM client_ledger WHERE source_entity_type = 'pedido' AND source_entity_id IN (SELECT id::TEXT FROM ${TP} p);
DELETE FROM pedido_lineas WHERE pedido_id IN ${TP};
DELETE FROM pedidos WHERE id IN ${TP};
DELETE FROM audit_events WHERE entity_type = 'sales_session_cash_event'
   AND entity_id IN (SELECT id::TEXT FROM sales_session_cash_event WHERE sales_session_id IN ${TS});
DELETE FROM sales_session_cash_event WHERE sales_session_id IN ${TS};
DELETE FROM audit_events WHERE entity_type = 'sales_session_movement'
   AND entity_id IN (SELECT id::TEXT FROM sales_session_movement WHERE sales_session_id IN ${TS});
DELETE FROM sales_session_movement WHERE sales_session_id IN ${TS};
DELETE FROM audit_events WHERE entity_type = 'sales_session' AND entity_id IN (SELECT id::TEXT FROM ${TS} s);
DELETE FROM sales_session WHERE id IN ${TS};
DELETE FROM fiscal_payment WHERE fiscal_obligation_id IN ${obl};
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM audit_events WHERE entity_type = 'fiscal_obligation' AND entity_id IN (SELECT id::TEXT FROM fiscal_obligation WHERE id IN ${obl});
DELETE FROM fiscal_obligation_installment WHERE fiscal_obligation_id IN ${obl};
DELETE FROM fiscal_obligation WHERE id IN ${obl};
DELETE FROM audit_events WHERE entity_type = 'fiscal_document' AND entity_id IN (SELECT id::TEXT FROM fiscal_document WHERE external_number LIKE '${TAG}%');
DELETE FROM fiscal_document_component WHERE fiscal_document_id IN (SELECT id FROM fiscal_document WHERE external_number LIKE '${TAG}%');
DELETE FROM fiscal_document WHERE external_number LIKE '${TAG}%';
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
DELETE FROM financial_account WHERE nombre LIKE '${TAG}%';`);
}

beforeAll(async () => {
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await service.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
  fx.today = owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE::TEXT;`);
  FAR_PERIOD = owner(`SELECT periodo_fecha::TEXT FROM management_period WHERE status = 'OPEN'
    AND periodo_fecha NOT IN (SELECT fiscal_period FROM fiscal_obligation WHERE tax_kind IN ('IIBB', 'OTHER')) ORDER BY periodo_fecha DESC LIMIT 1;`);
  if (!FAR_PERIOD) throw new Error('no free open management period for the fiscal fixture');
  fx.cash = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} caja feria`, account_type: 'CASH' })).id;
  fx.bank = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} banco`, account_type: 'BANK_ACCOUNT' })).id;
  fx.category = (await createMaster<{ id: string }>(admin(), 'expense_category', { nombre: `${TAG} gastos feria`, pnl_cost_class: 'INDIRECT' })).id;
  fx.product = (await createMaster<{ id: string }>(admin(), 'products', { nombre: `${TAG} maple`, product_type: 'VENDIBLE', unit_type: 'CARTON' })).id;
  fx.supplier = (await createMaster<{ id: string }>(admin(), 'suppliers', { nombre: `${TAG} proveedor` })).id;
  fx.client = (await createMaster<{ id: string }>(admin(), 'clients', { nombre: `${TAG} cliente` })).id;
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('F27-F Feria session (open → movements → cash events → count → close)', () => {
  let sessionId = '';
  const key = `${TAG}-S1`;

  it('only ADMIN opens a session; an opening fund needs a cash account; the key is idempotent', async () => {
    expect(denied(await openSalesSession(operator(), { date: fx.today, location: `${TAG} plaza`, idempotencyKey: `${TAG}-X` }).catch((e) => e))).toBe(true);
    const noAccount = await openSalesSession(admin(), { date: fx.today, location: `${TAG} plaza`, idempotencyKey: `${TAG}-Y`, openingFund: 5000 }).catch((e) => e);
    expect(code(noAccount)).toBe('ACCOUNT_REQUIRED');
    sessionId = (await openSalesSession(admin(), { date: fx.today, location: `${TAG} plaza`, idempotencyKey: key, openingFund: 5000, cashAccountId: fx.cash })).session_id;
    const dup = await openSalesSession(admin(), { date: fx.today, location: `${TAG} plaza`, idempotencyKey: key }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_SESSION');
  });

  it('[ADR-009] RPC 31 is ADMIN-only: ADMIN records goods movements (validated by the backend); OPERATOR is refused', async () => {
    const opMove = await registerSessionMovement(operator(), { sessionId, type: 'DISPATCH', productoId: fx.product, cantidad: 40 }).catch((e) => e);
    expect(code(opMove)).toBe('FORBIDDEN');
    await registerSessionMovement(admin(), { sessionId, type: 'DISPATCH', productoId: fx.product, cantidad: 40 });
    await registerSessionMovement(admin(), { sessionId, type: 'RETURN', productoId: fx.product, cantidad: 5 });
    const loss = await registerSessionMovement(admin(), { sessionId, type: 'LOSS', productoId: fx.product, cantidad: 1 }).catch((e) => e);
    expect(code(loss)).toBe('REASON_REQUIRED');
    const zero = await registerSessionMovement(admin(), { sessionId, type: 'DISPATCH', productoId: fx.product, cantidad: 0 }).catch((e) => e);
    expect(code(zero)).toBe('INVALID_QUANTITY');
    const moves = await listSessionMovements(admin(), sessionId);
    expect(moves.map((m) => [m.movement_type, m.cantidad]).sort()).toEqual([['DISPATCH', 40], ['RETURN', 5]]);
    expect(moves[0].producto_nombre).toBe(`${TAG} maple`);
    expect(owner(`SELECT count(*) FROM sales_session_movement WHERE sales_session_id = '${sessionId}' AND created_by = '${users.OPERATOR.id}';`)).toBe('0');
  });

  it('[ADR-009] OPERATOR product and price access is exactly as before: no products, no price_history', async () => {
    expect((await operator().from('products').select('id')).data ?? []).toEqual([]);
    expect((await operator().from('price_history').select('id')).data ?? []).toEqual([]);
    expect(owner(`SELECT count(*) FROM pg_policies WHERE tablename IN ('products', 'price_history')
      AND (coalesce(qual, '') LIKE '%OPERATOR%' OR coalesce(with_check, '') LIKE '%OPERATOR%');`)).toBe('0');
  });

  it('cash events are ADMIN; a COUNT is an observation and the view reports expected cash and a visible variance', async () => {
    expect(denied(await registerSessionCashEvent(operator(), { sessionId, type: 'COUNT', amount: 1 }).catch((e) => e))).toBe(true);
    const noCat = await registerSessionCashEvent(admin(), { sessionId, type: 'EXPENSE', amount: 300, accountId: fx.cash }).catch((e) => e);
    expect(code(noCat)).toBe('CATEGORY_REQUIRED');
    const fund = await registerSessionCashEvent(admin(), { sessionId, type: 'OPENING_FUND' as never, amount: 1, accountId: fx.cash }).catch((e) => e);
    expect(code(fund)).toBe('INVALID_EVENT_TYPE');
    const noDest = await registerSessionCashEvent(admin(), { sessionId, type: 'TRANSFER_OUT', amount: 1, accountId: fx.cash }).catch((e) => e);
    expect(code(noDest)).toBe('DESTINATION_REQUIRED');

    const cashBefore = (await listLedgerBalances(admin(), 'ACCOUNT')).find((b) => b.entity_id === fx.cash)?.balance ?? 0;
    await registerSessionCashEvent(admin(), { sessionId, type: 'EXPENSE', amount: 300, accountId: fx.cash, categoryId: fx.category, reason: 'bolsas' });
    await registerSessionCashEvent(admin(), { sessionId, type: 'WITHDRAWAL', amount: 1000, accountId: fx.cash });
    const count = await registerSessionCashEvent(admin(), { sessionId, type: 'COUNT', amount: 4000 });
    expect(count.financial_operation_id).toBeNull();
    expect((await listLedgerBalances(admin(), 'ACCOUNT')).find((b) => b.entity_id === fx.cash)?.balance).toBe(cashBefore - 1300);

    const row = (await listSessionCash(admin(), fx.today, fx.today)).find((r) => r.sales_session_id === sessionId)!;
    expect(row).toMatchObject({ opening_fund: 5000, expenses: 300, withdrawals: 1000, expected_cash: 3700, counted_cash: 4000, variance: 300, estado: 'OPEN' });
    expect(await listSessionCash(operator(), fx.today, fx.today)).toEqual([]);
  });

  it('only ADMIN closes; the aggregated retail lines become the CONSUMIDOR FINAL order; a closed session takes nothing more', async () => {
    expect(denied(await closeSalesSession(operator(), { sessionId, lines: [] }).catch((e) => e))).toBe(true);
    const bad = await closeSalesSession(admin(), { sessionId, lines: [{ producto_id: fx.product, cantidad: 0, precio_unitario: 1000 }] }).catch((e) => e);
    expect(code(bad)).toBe('INVALID_QUANTITY');
    const r = await closeSalesSession(admin(), { sessionId, lines: [{ producto_id: fx.product, cantidad: 30, precio_unitario: 1000 }] });
    expect(r).toMatchObject({ estado: 'CLOSED', aggregated_total: 30000 });
    expect(r.aggregated_pedido_id).toBeTruthy();
    expect(owner(`SELECT c.nombre || '|' || p.estado FROM pedidos p JOIN clients c ON c.id = p.cliente_id WHERE p.id = '${r.aggregated_pedido_id}';`))
      .toBe('CONSUMIDOR FINAL|DELIVERED');
    expect(code(await closeSalesSession(admin(), { sessionId, lines: [] }).catch((e) => e))).toBe('SESSION_ALREADY_CLOSED');
    expect(code(await registerSessionMovement(admin(), { sessionId, type: 'DISPATCH', productoId: fx.product, cantidad: 1 }).catch((e) => e))).toBe('SESSION_CLOSED');
    expect(code(await registerSessionCashEvent(admin(), { sessionId, type: 'COUNT', amount: 1 }).catch((e) => e))).toBe('SESSION_CLOSED');
    expect((await listSessions(operator())).map((s) => s.id)).not.toContain(sessionId);
    expect((await listSessionCash(admin(), fx.today, fx.today)).find((r2) => r2.sales_session_id === sessionId)?.estado).toBe('CLOSED');
  });

  it('no direct path: session, cash-event, posting and legacy cash-count rows cannot be written', async () => {
    for (const c of [admin(), operator()]) {
      expect((await c.from('sales_session').insert({ session_date: fx.today, location: `${TAG} x`, estado: 'OPEN', idempotency_key: randomUUID() }).select()).error).not.toBeNull();
      expect((await c.from('sales_session_cash_event').insert({ sales_session_id: sessionId, event_type: 'COUNT', amount: 1, event_date: fx.today }).select()).error).not.toBeNull();
      expect((await c.from('financial_posting').insert({ financial_account_id: fx.cash, signed_amount: 1, effective_date: fx.today }).select()).error).not.toBeNull();
    }
    expect(owner(`SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('arqueos_caja', 'cuentas_caja');`)).toBe('0');
    await expect(writeTable(admin(), 'sales_session' as never, 'insert' as never, {})).rejects.toMatchObject({ code: 'DIRECT_WRITE_NOT_ALLOWED' });
  });
});

describe('F27-F fiscal records (ADMIN only; no external fiscal service)', () => {
  it('ADMIN records a supplier document with its components; the backend enforces counterpart, period and uniqueness', async () => {
    const base = {
      type: 'INVOICE_A' as const, direction: 'CREDITO' as const, date: fx.today, fiscalPeriod: firstOfMonth(fx.today), netAmount: 1000, totalAmount: 1210,
      components: [{ tax_kind: 'IVA' as const, direction: 'CREDITO' as const, base_amount: 1000, rate_applied: 21, tax_amount: 210 }],
    };
    const noSupplier = await registerFiscalDocument(admin(), { ...base, externalNumber: `${TAG}-0001` }).catch((e) => e);
    expect(code(noSupplier)).toBe('SUPPLIER_REQUIRED');
    const badPeriod = await registerFiscalDocument(admin(), { ...base, fiscalPeriod: fx.today.slice(0, 8) + '15', supplierId: fx.supplier, externalNumber: `${TAG}-0001` }).catch((e) => e);
    expect(code(badPeriod)).toBe('INVALID_FISCAL_PERIOD');
    const r = await registerFiscalDocument(admin(), { ...base, supplierId: fx.supplier, externalNumber: `${TAG}-0001` });
    expect(r.component_count).toBe(1);
    const dup = await registerFiscalDocument(admin(), { ...base, supplierId: fx.supplier, externalNumber: `${TAG}-0001` }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_FISCAL_DOCUMENT');
    const doc = (await listFiscalDocuments(admin())).find((d) => d.id === r.fiscal_document_id)!;
    expect(doc).toMatchObject({ contraparte: `${TAG} proveedor`, total_amount: 1210 });
    const noClient = await registerFiscalDocument(admin(), { ...base, direction: 'DEBITO', externalNumber: `${TAG}-0002` }).catch((e) => e);
    expect(code(noClient)).toBe('CLIENT_REQUIRED');
    await registerFiscalDocument(admin(), { ...base, type: 'INVOICE_B', direction: 'DEBITO', clienteId: fx.client, externalNumber: `${TAG}-0003`, components: [] });
  });

  it('an obligation in installments must add up; paying an installment moves the account and the status; overpayment is refused', async () => {
    const mismatch = await registerFiscalObligation(admin(), {
      taxKind: 'IIBB', fiscalPeriod: FAR_PERIOD, amount: 900, installments: [{ installment_number: 1, amount: 400, due_date: fx.today }],
    }).catch((e) => e);
    expect(code(mismatch)).toBe('INSTALLMENT_MISMATCH');
    const o = await registerFiscalObligation(admin(), {
      taxKind: 'IIBB', fiscalPeriod: FAR_PERIOD, amount: 900,
      installments: [{ installment_number: 1, amount: 450, due_date: fx.today }, { installment_number: 2, amount: 450, due_date: fx.today }],
    });
    obligations.push(o.obligation_id);
    expect(o.installment_count).toBe(2);
    expect(code(await registerFiscalObligation(admin(), { taxKind: 'IIBB', fiscalPeriod: FAR_PERIOD, amount: 1 }).catch((e) => e))).toBe('DUPLICATE_OBLIGATION');

    const [first] = (await listObligations(admin())).find((x) => x.id === o.obligation_id)!.installments;
    const bankBefore = (await listLedgerBalances(admin(), 'ACCOUNT')).find((b) => b.entity_id === fx.bank)?.balance ?? 0;
    await payFiscalObligation(admin(), { obligationId: o.obligation_id, date: fx.today, amount: 450, accountId: fx.bank, idempotencyKey: `${TAG}-PAY1`, installmentId: first.id });
    expect((await listObligations(admin())).find((x) => x.id === o.obligation_id)?.status).toBe('PARTIALLY_PAID');
    expect((await listLedgerBalances(admin(), 'ACCOUNT')).find((b) => b.entity_id === fx.bank)?.balance).toBe(bankBefore - 450);
    const over = await payFiscalObligation(admin(), { obligationId: o.obligation_id, date: fx.today, amount: 500, accountId: fx.bank, idempotencyKey: `${TAG}-PAY2` }).catch((e) => e);
    expect(code(over)).toBe('OVERPAYMENT');
    const dup = await payFiscalObligation(admin(), { obligationId: o.obligation_id, date: fx.today, amount: 450, accountId: fx.bank, idempotencyKey: `${TAG}-PAY1` }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_PAYMENT');
  });

  it('OPERATOR can neither read nor record fiscal data, and fiscal rows cannot be written directly', async () => {
    expect(await listFiscalDocuments(operator())).toEqual([]);
    expect(await listObligations(operator())).toEqual([]);
    expect(denied(await registerFiscalObligation(operator(), { taxKind: 'OTHER', fiscalPeriod: FAR_PERIOD, amount: 1 }).catch((e) => e))).toBe(true);
    expect(denied(await registerFiscalDocument(operator(), {
      type: 'OTHER', direction: 'CREDITO', date: fx.today, fiscalPeriod: firstOfMonth(fx.today), netAmount: 1, totalAmount: 1, components: [], supplierId: fx.supplier,
    }).catch((e) => e))).toBe(true);
    for (const c of [admin(), operator()]) {
      expect((await c.from('fiscal_document').insert({ document_type: 'OTHER', direction: 'CREDITO', document_date: fx.today, fiscal_period: firstOfMonth(fx.today), net_amount: 1, total_amount: 1 }).select()).error).not.toBeNull();
      expect((await c.from('fiscal_obligation').insert({ tax_kind: 'OTHER', fiscal_period: FAR_PERIOD, amount: 1 }).select()).error).not.toBeNull();
    }
  });
});
