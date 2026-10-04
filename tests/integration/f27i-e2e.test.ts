/**
 * F27-I integrated validation: representative end-to-end flows ACROSS slices, through the frontend data layer only
 * (src/target/*), against the guarded LOCAL stack. Each flow chains real effects and reads them back from the
 * authoritative views (report_balance_period, report_sales_line, report_flock_day, pnl_summary / pnl_line_item,
 * report_feria_session_cash, the Step-10 MP views). Storage-API purchase attachments stay SKIPPED / PRE-CUTOVER
 * REQUIRED (E-F27D-2): the purchase here uses fixture attachment metadata through the RPC, as in f27d.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { ensureLocalMpBoundary } from '../../scripts/test-env/mp-boundary-fixture.mjs';   // ADR-017: RPC 40 needs the cutover boundary (fail safe)
import { TargetDbError } from '../../src/target/db';
import { resolveTargetRole } from '../../src/target/role';
import { modulesFor } from '../../src/target/roles';
import { assignOperator, closeFlock, createMaster, listMaster, registerFlock, setPrice } from '../../src/target/masters';
import { createPendingOrder, deliverOrder, listClientBalances, listSalesLines, registerCollection } from '../../src/target/commercial';
import { listLedgerBalances, paySupplier, registerPurchase } from '../../src/target/treasury';
import { listFlockDays, listFlockOptions, registerCountAdjustment, registerDailyProduction, registerMortality } from '../../src/target/production';
import { registerClassification } from '../../src/target/classification';
import { assignFlockFeed } from '../../src/target/feed';
import { closeSalesSession, listSessionCash, listSessions, openSalesSession, registerSessionCashEvent, registerSessionMovement } from '../../src/target/feria';
import { listObligations, payFiscalObligation, registerFiscalDocument, registerFiscalObligation } from '../../src/target/fiscal';
import { listPnlLineItems, listPnlSummary } from '../../src/target/pnl';
import { allocateToClient, getReceipt, listReceipts, uiIdempotencyKey } from '../../src/target/mp';

const LOCAL_URL = 'http://127.0.0.1:54321';
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
ensureLocalMpBoundary();

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
function psql(sql: string): { ok: boolean; out: string; err: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: r.stderr || '' };
}
function owner(sql: string): string { const r = psql(sql); if (!r.ok) throw new Error(r.err); return r.out; }
const q = (v: unknown) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
function svc(call: string): any {
  const r = psql(`BEGIN;\nSET LOCAL ROLE service_role;\nSET LOCAL "request.jwt.claims" = '{"role":"service_role"}';\nSELECT (${call})::text;\nCOMMIT;`);
  if (!r.ok) throw new Error(r.err);
  return JSON.parse(r.out.split('\n').find((l) => l.startsWith('{')) ?? '{}');
}

const keys = localKeys();
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(LOCAL_URL, keys.service, opts);
const run = randomUUID().slice(0, 8);
const TAG = `F27I-${run}`;
const password = `F27i-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR' | 'NOPROFILE', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27i-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27i-operator-${run}@example.invalid` },
  NOPROFILE: { email: `f27i-former-repartidor-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const denied = (e: unknown) => e instanceof TargetDbError && ['PERMISSION_DENIED', 'RLS_DENIED', 'FORBIDDEN'].includes(e.code);
const fx = { today: '', period: '', client: '', product: '', cash: '', bank: '', supplier: '', category: '', shed: '', flock: '', grade: '', feedType: '' };
const obligations: string[] = [];
const day = (n: number) => owner(`SELECT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE + ${n})::TEXT;`);
const pnl = async (col: 'ventas_netas_devengadas' | 'costos_directos') => (await listPnlSummary(admin(), fx.period, fx.period))[0]?.[col] ?? 0;
const bal = async (ledger: 'ACCOUNT' | 'SUPPLIER', id: string) => (await listLedgerBalances(admin(), ledger)).find((b) => b.entity_id === id)?.balance ?? 0;
const clientBal = async () => (await listClientBalances(admin())).find((b) => b.cliente_id === fx.client)?.balance ?? 0;

// MP fixture: the backend's own service pipeline (as in mp_views / f27h), payments 7781…
const digits = String(parseInt(run.slice(0, 6), 16)).padStart(8, '0').slice(-8);
function mpReceipt() {
  const pid = `7781${digits.slice(-4)}${String(Date.now()).slice(-6)}`;
  const at = '2026-11-05T10:00:00.000-04:00';
  const body = { id: Number(pid), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
    collector_id: 100000001, payer: { id: `8010${digits}` }, external_reference: null, date_created: at, date_approved: at, transaction_amount: 100,
    transaction_details: { net_received_amount: 93 }, fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }], refunds: [],
    transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
  const d = svc(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, ${q(TAG)}, ${q(JSON.stringify({ notification_id: `${TAG}-${pid}` }))}::jsonb, true)`).delivery_id;
  const cl = psql(`BEGIN;\nSET LOCAL ROLE service_role;\nSET LOCAL "request.jwt.claims" = '{"role":"service_role"}';\nSELECT coalesce(json_agg(c), '[]')::text FROM mp_claim_deliveries(50, 120) c;\nCOMMIT;`);
  const tok = (JSON.parse(cl.out.split('\n').find((l) => l.startsWith('[')) ?? '[]') as { delivery_id: string; claim_token: string }[]).find((x) => x.delivery_id === d)!.claim_token;
  const src = svc(`mp_ingest_api_snapshot(${q(d)}, ${q(tok)}, ${q(pid)}, ${q(JSON.stringify(body))}::jsonb)`);
  if (src.processing_status === 'PENDING') svc(`mp_normalize_source(${q(src.source_record_id)})`);
  const mv = Number(owner(`SELECT m.id FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
    WHERE t.resource_type = 'payment' AND t.resource_id = ${q(pid)} AND t.transition = 'APPROVAL';`));
  svc(`mp_apply_transition(${mv})`);
  svc(`mp_auto_allocate(${mv})`);
  svc(`mp_delivery_transition(${q(d)}, ${q(tok)}, 'FETCHED', ${q(src.source_record_id)}, NULL, NULL, NULL, NULL)`);
  return { pid, mv };
}

function cleanup() {
  const obl = obligations.length ? `(${obligations.map((o) => `'${o}'`).join(',')})` : '(NULL::UUID)';
  owner(`
CREATE TEMP TABLE _cl AS SELECT id FROM clients WHERE nombre LIKE '${TAG}%';
CREATE TEMP TABLE _sup AS SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%';
CREATE TEMP TABLE _acc AS SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%';
CREATE TEMP TABLE _sh AS SELECT id FROM sheds WHERE nombre LIKE '${TAG}%';
CREATE TEMP TABLE _fk AS SELECT id FROM flocks WHERE shed_id IN (SELECT id FROM _sh);
CREATE TEMP TABLE _ft AS SELECT id FROM feed_type WHERE nombre LIKE '${TAG}%';
CREATE TEMP TABLE _ss AS SELECT id FROM sales_session WHERE location LIKE '${TAG}%';
CREATE TEMP TABLE _pe AS SELECT id FROM pedidos WHERE cliente_id IN (SELECT id FROM _cl) OR sales_session_id IN (SELECT id FROM _ss);
CREATE TEMP TABLE _pu AS SELECT id FROM purchases WHERE supplier_id IN (SELECT id FROM _sup);
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7781%' OR external_id LIKE '${TAG}%';
CREATE TEMP TABLE _mv AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _al AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7781%';
CREATE TEMP TABLE _cls AS SELECT id FROM classification WHERE location LIKE '${TAG}%';
CREATE TEMP TABLE _o AS
  SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%'
  UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN (SELECT id FROM _acc)
  UNION SELECT financial_operation_id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv)
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'sales_session' AND source_entity_id IN (SELECT id::TEXT FROM _ss)
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'fiscal_obligation' AND source_entity_id IN (SELECT id::TEXT FROM fiscal_obligation WHERE id IN ${obl});
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT client_ledger_id FROM _al);
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE triggered_by_delivery_id IN (SELECT id FROM _dl) OR key_conflict_of IN (SELECT id FROM _dl);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
UPDATE sales_session SET aggregated_pedido_id = NULL WHERE id IN (SELECT id FROM _ss);
DELETE FROM collections WHERE cliente_id IN (SELECT id FROM _cl);
DELETE FROM client_ledger WHERE reversal_of_id IS NOT NULL AND (cliente_id IN (SELECT id FROM _cl) OR (source_entity_type = 'pedido' AND source_entity_id IN (SELECT id::TEXT FROM _pe)));
DELETE FROM client_ledger WHERE cliente_id IN (SELECT id FROM _cl) OR (source_entity_type = 'pedido' AND source_entity_id IN (SELECT id::TEXT FROM _pe));
DELETE FROM pedido_lineas WHERE pedido_id IN (SELECT id FROM _pe);
DELETE FROM pedidos WHERE id IN (SELECT id FROM _pe);
DELETE FROM sales_session_cash_event WHERE sales_session_id IN (SELECT id FROM _ss);
DELETE FROM sales_session_movement WHERE sales_session_id IN (SELECT id FROM _ss);
DELETE FROM sales_session WHERE id IN (SELECT id FROM _ss);
DELETE FROM fiscal_payment WHERE fiscal_obligation_id IN ${obl};
DELETE FROM fiscal_obligation_installment WHERE fiscal_obligation_id IN ${obl};
DELETE FROM fiscal_obligation WHERE id IN ${obl};
DELETE FROM fiscal_document_component WHERE fiscal_document_id IN (SELECT id FROM fiscal_document WHERE external_number LIKE '${TAG}%');
DELETE FROM fiscal_document WHERE external_number LIKE '${TAG}%';
DELETE FROM purchase_attachment WHERE purchase_id IN (SELECT id FROM _pu);
DELETE FROM purchase_line WHERE purchase_id IN (SELECT id FROM _pu);
DELETE FROM purchases WHERE id IN (SELECT id FROM _pu);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM supplier_ledger WHERE reversal_of_id IS NOT NULL AND supplier_id IN (SELECT id FROM _sup);
DELETE FROM supplier_ledger WHERE supplier_id IN (SELECT id FROM _sup);
DELETE FROM classification_line WHERE classification_id IN (SELECT id FROM _cls);
DELETE FROM classification WHERE id IN (SELECT id FROM _cls);
DELETE FROM classification_grade WHERE nombre LIKE '${TAG}%';
DELETE FROM flock_feed_assignment WHERE flock_id IN (SELECT id FROM _fk) OR feed_type_id IN (SELECT id FROM _ft);
DELETE FROM feed_type WHERE id IN (SELECT id FROM _ft);
UPDATE daily_production SET superseded_by = NULL WHERE flock_id IN (SELECT id FROM _fk);
DELETE FROM daily_production WHERE flock_id IN (SELECT id FROM _fk);
UPDATE population_events SET superseded_by = NULL WHERE flock_id IN (SELECT id FROM _fk);
DELETE FROM population_events WHERE flock_id IN (SELECT id FROM _fk);
DELETE FROM operator_assignments WHERE flock_id IN (SELECT id FROM _fk);
DELETE FROM flocks WHERE id IN (SELECT id FROM _fk);
DELETE FROM sheds WHERE id IN (SELECT id FROM _sh);
DELETE FROM price_history WHERE producto_id IN (SELECT id FROM products WHERE nombre LIKE '${TAG}%');
DELETE FROM products WHERE nombre LIKE '${TAG}%';
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE id IN (SELECT id FROM _cl);
DELETE FROM suppliers WHERE id IN (SELECT id FROM _sup);
DELETE FROM financial_account WHERE id IN (SELECT id FROM _acc);`);
}

beforeAll(async () => {
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await service.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    if (role !== 'NOPROFILE') owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, opts);
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
  fx.today = day(0);
  fx.period = `${fx.today.slice(0, 7)}-01`;
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('F27-I role matrix (frontend UX mirrors the backend)', () => {
  it('ADMIN gets every module; OPERATOR only the production working set; a user without an active profile (former repartidor) gets none', async () => {
    expect(await resolveTargetRole(admin())).toBe('ADMIN');
    expect(await resolveTargetRole(operator())).toBe('OPERATOR');
    expect(await resolveTargetRole(users.NOPROFILE.client!)).toBeNull();
    expect(modulesFor('ADMIN')).toEqual(['dashboard_produccion', 'produccion', 'clasificacion', 'alimento', 'pedidos', 'cobros', 'caja', 'feria', 'fiscal', 'mercadopago', 'finanzas', 'admin']);
    expect(modulesFor('OPERATOR')).toEqual(['produccion', 'clasificacion', 'alimento']);
    expect(modulesFor(null)).toEqual([]);
  });

  it('OPERATOR reads nothing ADMIN-only across domains (masters, commercial, treasury, Feria, fiscal, P&L, MP)', async () => {
    expect(await listMaster(operator(), 'clients')).toEqual([]);
    expect(await listClientBalances(operator())).toEqual([]);
    expect(await listLedgerBalances(operator(), 'ACCOUNT')).toEqual([]);
    expect(await listSessions(operator())).toEqual([]);
    expect(await listObligations(operator())).toEqual([]);
    expect(await listPnlSummary(operator(), '2020-01-01', '2030-12-01')).toEqual([]);
    expect(await listReceipts(operator(), { from: '2020-01-01', to: '2030-12-31', axisA: null, axisB: null })).toEqual([]);
  });
});

describe('F27-I cross-slice flows', () => {
  it('FLOW A + F — commercial: masters → PENDING order → delivery → collection; the sale reaches report_sales_line, pnl_summary and the client balance', async () => {
    fx.client = (await createMaster<{ id: string }>(admin(), 'clients', { nombre: `${TAG} cliente` })).id;
    fx.product = (await createMaster<{ id: string }>(admin(), 'products', { nombre: `${TAG} maple`, product_type: 'VENDIBLE', unit_type: 'CARTON' })).id;
    fx.cash = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} caja`, account_type: 'CASH' })).id;
    await setPrice(admin(), { productId: fx.product, list: 'MINORISTA', precio: 1500, effectiveFrom: fx.period, userId: users.ADMIN.id! });
    const ventasBefore = await pnl('ventas_netas_devengadas');
    const order = await createPendingOrder(admin(), { clienteId: fx.client, lines: [{ producto_id: fx.product, producto_nombre: `${TAG} maple`, cantidad: 4, precio_unitario: 1500 }], userId: users.ADMIN.id! });
    await deliverOrder(admin(), order.id);
    expect((await listSalesLines(admin(), fx.today, fx.today)).filter((l) => l.pedido_id === order.id).map((l) => l.subtotal)).toEqual([6000]);
    expect(await clientBal()).toBe(6000);
    expect((await pnl('ventas_netas_devengadas')) - ventasBefore).toBe(6000);
    expect((await listPnlLineItems(admin(), fx.period)).some((i) => i.source_entity_id === order.id && i.bucket === 'VENTAS_NETAS')).toBe(true);
    await registerCollection(admin(), { clienteId: fx.client, amount: 2500, method: 'CASH', receiptId: `${TAG}-R1`, effectiveDate: fx.today, accountId: fx.cash });
    expect(await clientBal()).toBe(3500);
    expect(await bal('ACCOUNT', fx.cash)).toBe(2500);
  });

  it('FLOW B + F — purchase / treasury: purchase (fixture attachment metadata) → supplier debt and direct cost in the P&L → supplier payment', async () => {
    fx.supplier = (await createMaster<{ id: string }>(admin(), 'suppliers', { nombre: `${TAG} proveedor` })).id;
    fx.category = (await createMaster<{ id: string }>(admin(), 'expense_category', { nombre: `${TAG} insumos`, pnl_cost_class: 'DIRECT' })).id;
    const costBefore = await pnl('costos_directos');
    const p = await registerPurchase(admin(), {
      supplierId: fx.supplier, economicDate: fx.today, amountNet: 1000, amountTotal: 1210, categoryId: fx.category, nature: 'OPERATING', lines: [],
      attachments: [{ storage_path: `test/${TAG}/f.pdf`, file_name: 'f.pdf', content_type: 'application/pdf', byte_size: 10 }], idempotencyKey: `${TAG}-P1`,
    });
    expect(await bal('SUPPLIER', fx.supplier)).toBe(1210);
    const item = (await listPnlLineItems(admin(), fx.period)).find((i) => i.source_entity_id === p.purchase_id)!;
    expect(item.bucket).toBe('COSTOS_DIRECTOS');
    expect((await pnl('costos_directos')) - costBefore).toBe(item.signed_amount);   // the summary is the line items' authority, read not summed here
    await paySupplier(admin(), { supplierId: fx.supplier, amount: 1210, effectiveDate: fx.today, method: 'CASH', accountId: fx.cash, externalRef: `${TAG}-PAY1` });
    expect(await bal('SUPPLIER', fx.supplier)).toBe(0);
    expect(await bal('ACCOUNT', fx.cash)).toBe(2500 - 1210);
  });

  it('FLOW C — flock lifecycle: flock → operator assignment → production / mortality / adjustment → classification → feed → close → post-exit protection', async () => {
    fx.shed = (await createMaster<{ id: string }>(admin(), 'sheds', { nombre: `${TAG} galpón`, capacidad: 2000 })).id;
    fx.flock = (await registerFlock(admin(), { shedId: fx.shed, entryDate: day(-10), initialPopulation: 1000 })).flock_id;
    await assignOperator(admin(), { operatorId: users.OPERATOR.id!, flockId: fx.flock, userId: users.ADMIN.id! });
    expect((await listFlockOptions(operator())).map((f) => f.id)).toEqual([fx.flock]);
    await registerDailyProduction(operator(), { flockId: fx.flock, date: day(-2), eggsTotal: 900, eggsBroken: 0, eggsDirty: 0 });
    await registerMortality(operator(), { flockId: fx.flock, date: day(-2), deaths: 10 });
    await registerCountAdjustment(operator(), { flockId: fx.flock, date: day(-1), delta: -5, reason: 'recuento' });
    expect((await listFlockDays(operator(), day(0), day(0))).find((d) => d.flock_id === fx.flock)?.population).toBe(985);
    fx.grade = await createGrade();
    await registerClassification(operator(), { idempotencyKey: randomUUID(), date: day(-1), location: `${TAG} sala`, lines: [{ classification_grade_id: fx.grade, quantity: 880 }] });
    fx.feedType = await createFeedType();
    await assignFlockFeed(admin(), { flockId: fx.flock, feedTypeId: fx.feedType, effectiveFrom: day(-5) });
    await closeFlock(admin(), { flockId: fx.flock, exitDate: day(-1) });
    expect(code(await registerMortality(admin(), { flockId: fx.flock, date: day(0), deaths: 1 }).catch((e) => e))).toBe('ACTIVITY_AFTER_FLOCK_EXIT');
    expect(await listFlockOptions(operator())).toEqual([]);   // closing deactivated the assignment (ADR-007 D-F27B-5)
  });

  it('FLOW D — Feria (ADMIN only, reads included): open → movement → cash + count → close; OPERATOR neither reads nor writes', async () => {
    const s = (await openSalesSession(admin(), { date: fx.today, location: `${TAG} plaza`, idempotencyKey: `${TAG}-S1`, openingFund: 1000, cashAccountId: fx.cash })).session_id;
    expect(code(await registerSessionMovement(operator(), { sessionId: s, type: 'DISPATCH', productoId: fx.product, cantidad: 1 }).catch((e) => e))).toBe('FORBIDDEN');
    await registerSessionMovement(admin(), { sessionId: s, type: 'DISPATCH', productoId: fx.product, cantidad: 20 });
    await registerSessionCashEvent(admin(), { sessionId: s, type: 'COUNT', amount: 1100 });
    const row = (await listSessionCash(admin(), fx.today, fx.today)).find((r) => r.sales_session_id === s)!;
    expect(row).toMatchObject({ expected_cash: 1000, counted_cash: 1100, variance: 100 });
    expect(await listSessions(operator())).toEqual([]);
    expect(await listSessionCash(operator(), fx.today, fx.today)).toEqual([]);
    const closed = await closeSalesSession(admin(), { sessionId: s, lines: [{ producto_id: fx.product, cantidad: 10, precio_unitario: 1500 }] });
    expect(closed).toMatchObject({ estado: 'CLOSED', aggregated_total: 15000 });
  });

  it('FLOW E — fiscal (ADMIN): document + obligation + payment; OPERATOR is refused', async () => {
    await registerFiscalDocument(admin(), {
      type: 'INVOICE_A', direction: 'CREDITO', date: fx.today, fiscalPeriod: fx.period, netAmount: 1000, totalAmount: 1210, supplierId: fx.supplier,
      components: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 1000, rate_applied: 21, tax_amount: 210 }], externalNumber: `${TAG}-FC1`,
    });
    const period = owner(`SELECT periodo_fecha::TEXT FROM management_period WHERE status = 'OPEN'
      AND periodo_fecha NOT IN (SELECT fiscal_period FROM fiscal_obligation WHERE tax_kind = 'GANANCIAS') ORDER BY periodo_fecha DESC LIMIT 1;`);
    const o = await registerFiscalObligation(admin(), { taxKind: 'GANANCIAS', fiscalPeriod: period, amount: 300 });
    obligations.push(o.obligation_id);
    await payFiscalObligation(admin(), { obligationId: o.obligation_id, date: fx.today, amount: 300, accountId: fx.cash, idempotencyKey: `${TAG}-FP1` });
    expect((await listObligations(admin())).find((x) => x.id === o.obligation_id)?.status).toBe('PAID');
    expect(denied(await registerFiscalObligation(operator(), { taxKind: 'OTHER', fiscalPeriod: period, amount: 1 }).catch((e) => e))).toBe(true);
  });

  it('FLOW G — MP: a receipt through the backend pipeline is CLIENT_UNASSIGNED (valid); C1 assigns it and the client balance moves (axis B only)', async () => {
    const r = mpReceipt();
    const before = await clientBal();
    const row = (await getReceipt(admin(), r.mv)).receipt!;
    expect(row).toMatchObject({ axis_a_state: 'POSTED', axis_b_state: 'CLIENT_UNASSIGNED' });
    await allocateToClient(admin(), { movementId: r.mv, clienteId: fx.client, amount: 50, effectiveDate: '2026-11-05', idempotencyKey: uiIdempotencyKey(), reason: 'cliente identificado' });
    const after = (await getReceipt(admin(), r.mv)).receipt!;
    expect(after).toMatchObject({ axis_a_state: 'POSTED', axis_b_state: 'CLIENT_PARTIAL', active_attributed: 50 });
    expect((await clientBal()) - before).toBe(-50);
  });
});

async function createGrade(): Promise<string> {
  const { writeTable } = await import('../../src/target/db');
  return ((await writeTable(admin(), 'classification_grade', 'insert', { nombre: `${TAG} N1` })) as { id: string }[])[0].id;
}
async function createFeedType(): Promise<string> {
  const { writeTable } = await import('../../src/target/db');
  return ((await writeTable(admin(), 'feed_type', 'insert', { nombre: `${TAG} postura`, feed_category: 'LAYER' })) as { id: string }[])[0].id;
}
