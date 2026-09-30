/**
 * F27-D integration: treasury, supplier payments, purchases / freight and the cheque / eCheq lifecycle through the
 * frontend data layer (src/target/treasury.ts) against the guarded LOCAL stack only (127.0.0.1, local demo keys
 * read from the running container). Every effect is read back from report_balance_period; OPERATOR is refused by
 * the database; nothing is written to a ledger, posting or instrument row directly.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { readTable, readView, TargetDbError, writeTable } from '../../src/target/db';
import { createPurchaseWithAttachments } from '../../src/target/attachments';
import { createMaster } from '../../src/target/masters';
import {
  assignFreightToPurchase, cancelSupplierInstrument, clearCheque, depositCheque, endorseCheque, issueSupplierInstrument, listFreight,
  listInstruments, listLedgerBalances, listPnlMonths, listPurchases, markSupplierInstrumentDebited, paySupplier, receiveCheque, rectifyPurchase,
  registerFreight, registerPurchase, rejectCheque, rejectSupplierInstrument, transferBetweenAccounts, type PurchaseLineInput,
} from '../../src/target/treasury';

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
const TAG = `F27D-${run}`;
const password = `F27d-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27d-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27d-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const fx = { cash: '', bank: '', supplierId: '', clientId: '', categoryId: '', day: '' };
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const denied = (e: unknown) => e instanceof TargetDbError && ['PERMISSION_DENIED', 'RLS_DENIED', 'FORBIDDEN'].includes(e.code);
const ref = (s: string) => `${TAG}-${s}`;
const balance = async (ledger: 'ACCOUNT' | 'SUPPLIER' | 'CLIENT', id: string) =>
  ledger === 'CLIENT'
    ? (await readView<{ entity_id: string; closing_balance: number }>(admin(), 'report_balance_period',
      (q) => q.eq('ledger', 'CLIENT').eq('entity_id', id).order('period'))).map((r) => Number(r.closing_balance)).at(-1) ?? 0
    : (await listLedgerBalances(admin(), ledger)).find((b) => b.entity_id === id)?.balance ?? 0;
const LINE: PurchaseLineInput = { producto_id: null, feed_ingredient_id: null, descripcion: `${TAG} insumo`, cantidad: 10, unit_type: 'KG', precio_unitario: 100 };
const ATTACHMENT = { storage_path: `test/${TAG}/factura.pdf`, file_name: 'factura.pdf', content_type: 'application/pdf', byte_size: 1024 };

const TS = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const TC = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const TA = `(SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _p AS SELECT id FROM purchases WHERE supplier_id IN ${TS};
CREATE TEMP TABLE _f AS SELECT id FROM freight WHERE supplier_id IN ${TS} OR idempotency_key LIKE '${TAG}%';
CREATE TEMP TABLE _i AS SELECT id FROM financial_instrument WHERE supplier_id IN ${TS} OR endorsed_to_supplier_id IN ${TS} OR cliente_id IN ${TC};
CREATE TEMP TABLE _o AS
  SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%'
  UNION SELECT id FROM financial_operation WHERE source_entity_type = 'financial_instrument' AND source_entity_id IN (SELECT id::TEXT FROM _i)
  UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN ${TA};
DELETE FROM audit_events WHERE entity_id IN (SELECT id::TEXT FROM _p UNION SELECT id::TEXT FROM _f UNION SELECT id::TEXT FROM _i UNION SELECT id::TEXT FROM _o);
DELETE FROM audit_events WHERE entity_type = 'freight_allocation' AND entity_id IN
  (SELECT id::TEXT FROM freight_allocation WHERE freight_id IN (SELECT id FROM _f) OR purchase_id IN (SELECT id FROM _p));
DELETE FROM freight_allocation WHERE freight_id IN (SELECT id FROM _f) OR purchase_id IN (SELECT id FROM _p);
DELETE FROM purchase_attachment WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchase_line WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchases WHERE id IN (SELECT id FROM _p);
DELETE FROM freight WHERE id IN (SELECT id FROM _f);
DELETE FROM financial_instrument_event WHERE financial_instrument_id IN (SELECT id FROM _i);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _o);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _o);
DELETE FROM supplier_ledger WHERE reversal_of_id IS NOT NULL AND supplier_id IN ${TS};
DELETE FROM supplier_ledger WHERE supplier_id IN ${TS};
DELETE FROM client_ledger WHERE cliente_id IN ${TC};
DELETE FROM financial_instrument WHERE id IN (SELECT id FROM _i);
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
  // masters through the F27-B layer (ADMIN)
  fx.cash = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} caja`, account_type: 'CASH' })).id;
  fx.bank = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} banco`, account_type: 'BANK_ACCOUNT' })).id;
  fx.supplierId = (await createMaster<{ id: string }>(admin(), 'suppliers', { nombre: `${TAG} proveedor` })).id;
  fx.clientId = (await createMaster<{ id: string }>(admin(), 'clients', { nombre: `${TAG} cliente` })).id;
  fx.categoryId = (await createMaster<{ id: string }>(admin(), 'expense_category', { nombre: `${TAG} insumos`, pnl_cost_class: 'DIRECT' })).id;
  fx.day = owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;`);
});

afterAll(async () => {
  if (STORAGE_UP && users.ADMIN.id) {   // uploaded receipts go through the API, so the stored files are removed too
    const names = owner(`SELECT string_agg(name, E'\\n') FROM storage.objects WHERE bucket_id = 'purchase-attachments' AND name LIKE '${users.ADMIN.id}/%';`)
      .split('\n').filter(Boolean);
    if (names.length) await service.storage.from('purchase-attachments').remove(names);
  }
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  // audit rows of the masters / operations this run's users created (fixture cleanup only)
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('F27-D treasury (ADMIN): balances come only from report_balance_period', () => {
  it('a transfer moves the account balances; invalid and duplicate transfers are refused; OPERATOR is refused', async () => {
    await transferBetweenAccounts(admin(), { sourceAccountId: fx.cash, destAccountId: fx.bank, amount: 1500, effectiveDate: fx.day, externalRef: ref('T1') });
    expect(await balance('ACCOUNT', fx.cash)).toBe(-1500);
    expect(await balance('ACCOUNT', fx.bank)).toBe(1500);

    const same = await transferBetweenAccounts(admin(), { sourceAccountId: fx.cash, destAccountId: fx.cash, amount: 1, effectiveDate: fx.day, externalRef: ref('T2') }).catch((e) => e);
    expect(code(same)).toBe('SAME_ACCOUNT');
    const zero = await transferBetweenAccounts(admin(), { sourceAccountId: fx.cash, destAccountId: fx.bank, amount: 0, effectiveDate: fx.day, externalRef: ref('T3') }).catch((e) => e);
    expect(code(zero)).toBe('INVALID_AMOUNT');
    const dup = await transferBetweenAccounts(admin(), { sourceAccountId: fx.cash, destAccountId: fx.bank, amount: 1500, effectiveDate: fx.day, externalRef: ref('T1') }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_TRANSFER');
    expect(await balance('ACCOUNT', fx.bank)).toBe(1500);

    const op = await transferBetweenAccounts(operator(), { sourceAccountId: fx.cash, destAccountId: fx.bank, amount: 10, effectiveDate: fx.day, externalRef: ref('T4') }).catch((e) => e);
    expect(denied(op)).toBe(true);
    expect(await listLedgerBalances(operator(), 'ACCOUNT')).toEqual([]);
    expect(await listPnlMonths(operator())).toEqual([]);
  });
});

describe('F27-D purchases, freight and supplier payments (ADMIN)', () => {
  let purchaseId = '';

  it('register_purchase recognises the debt in the supplier ledger; a purchase without an attachment is refused', async () => {
    const r = await registerPurchase(admin(), {
      supplierId: fx.supplierId, economicDate: fx.day, amountNet: 1000, amountTotal: 1210, categoryId: fx.categoryId, nature: 'OPERATING',
      lines: [LINE], attachments: [ATTACHMENT], idempotencyKey: ref('P1'), invoiceNumber: ref('FC1'),
    });
    purchaseId = r.purchase_id;
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(1210);
    const listed = (await listPurchases(admin())).find((p) => p.id === purchaseId)!;
    expect(listed).toMatchObject({ amount_total: 1210, supplier_nombre: `${TAG} proveedor`, categoria_nombre: `${TAG} insumos` });
    expect(listed.lineas[0].subtotal).toBe(1000);

    const noAtt = await registerPurchase(admin(), {
      supplierId: fx.supplierId, economicDate: fx.day, amountNet: 1, amountTotal: 1, categoryId: fx.categoryId, nature: 'OPERATING',
      lines: [LINE], attachments: [], idempotencyKey: ref('P2'),
    }).catch((e) => e);
    expect(code(noAtt)).toBe('ATTACHMENT_REQUIRED');
    const dup = await registerPurchase(admin(), {
      supplierId: fx.supplierId, economicDate: fx.day, amountNet: 1, amountTotal: 1, categoryId: fx.categoryId, nature: 'OPERATING',
      lines: [LINE], attachments: [ATTACHMENT], idempotencyKey: ref('P1'),
    }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_PURCHASE');
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(1210);
  });

  it('rectify_purchase requires a reason, replaces the current version and the balance follows; the old version is superseded', async () => {
    const noReason = await rectifyPurchase(admin(), { purchaseId, amountNet: 800, amountTotal: 968, lines: [{ ...LINE, cantidad: 8 }], reason: ' ' }).catch((e) => e);
    expect(code(noReason)).toBe('REASON_REQUIRED');
    const r = await rectifyPurchase(admin(), { purchaseId, amountNet: 800, amountTotal: 968, lines: [{ ...LINE, cantidad: 8 }], reason: 'devolución parcial' });
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(968);
    const current = (await listPurchases(admin())).filter((p) => p.supplier_id === fx.supplierId);
    expect(current.map((p) => p.id)).toEqual([r.new_purchase_id]);
    const again = await rectifyPurchase(admin(), { purchaseId, amountNet: 1, amountTotal: 1, lines: [LINE], reason: 'x' }).catch((e) => e);
    expect(code(again)).toBe('PURCHASE_SUPERSEDED');
    purchaseId = r.new_purchase_id;
  });

  it('freight is registered (supplier debt) and allocated to the purchase; over-allocation is refused', async () => {
    const f = await registerFreight(admin(), { economicDate: fx.day, amount: 200, categoryId: fx.categoryId, idempotencyKey: ref('F1'), supplierId: fx.supplierId });
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(1168);
    expect((await listFreight(admin())).map((x) => x.id)).toContain(f.freight_id);
    const a = await assignFreightToPurchase(admin(), { freightId: f.freight_id, purchaseId, amount: 150 });
    expect(Number(a.freight_remaining)).toBe(50);
    const over = await assignFreightToPurchase(admin(), { freightId: f.freight_id, purchaseId, amount: 100 }).catch((e) => e);
    expect(code(over)).toBe('OVER_ALLOCATION');
  });

  it('pay_supplier lowers the supplier debt and the paying account; cheques must go through issue_supplier_instrument', async () => {
    const cashBefore = await balance('ACCOUNT', fx.cash);
    await paySupplier(admin(), { supplierId: fx.supplierId, amount: 500, effectiveDate: fx.day, method: 'CASH', accountId: fx.cash, externalRef: ref('PAY1') });
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(668);
    expect(await balance('ACCOUNT', fx.cash)).toBe(cashBefore - 500);
    const cheque = await paySupplier(admin(), {
      supplierId: fx.supplierId, amount: 1, effectiveDate: fx.day, method: 'CHEQUE' as never, accountId: fx.cash, externalRef: ref('PAY2'),
    }).catch((e) => e);
    expect(code(cheque)).toBe('USE_ISSUE_SUPPLIER_INSTRUMENT');
    const dup = await paySupplier(admin(), { supplierId: fx.supplierId, amount: 500, effectiveDate: fx.day, method: 'CASH', accountId: fx.cash, externalRef: ref('PAY1') }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_PAYMENT');
  });

  it('OPERATOR can neither register nor read purchases, freight, instruments or balances', async () => {
    const reg = await registerPurchase(operator(), {
      supplierId: fx.supplierId, economicDate: fx.day, amountNet: 1, amountTotal: 1, categoryId: fx.categoryId, nature: 'OPERATING',
      lines: [LINE], attachments: [ATTACHMENT], idempotencyKey: ref('P9'),
    }).catch((e) => e);
    expect(denied(reg)).toBe(true);
    const pay = await paySupplier(operator(), { supplierId: fx.supplierId, amount: 1, effectiveDate: fx.day, method: 'CASH', accountId: fx.cash, externalRef: ref('PAY9') }).catch((e) => e);
    expect(denied(pay)).toBe(true);
    expect(await listPurchases(operator())).toEqual([]);
    expect(await listFreight(operator())).toEqual([]);
    expect(await listInstruments(operator())).toEqual([]);
    expect(await listLedgerBalances(operator(), 'SUPPLIER')).toEqual([]);
  });
});

// "Nueva compra" end to end (ADR-008) needs the local Storage service (started by the Supabase CLI)
const STORAGE_UP = await fetch(`${LOCAL_URL}/storage/v1/bucket`, { headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}` } })
  .then((r) => r.status === 200).catch(() => false);

describe.skipIf(!STORAGE_UP)('F27-D Nueva compra: upload → register_purchase (requires the local Storage service)', () => {
  const file = () => Object.assign(new Blob([new Uint8Array(32).fill(37)], { type: 'application/pdf' }), { name: 'factura.pdf' }) as File;
  const objects = () => Number(owner(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'purchase-attachments' AND name LIKE '${users.ADMIN.id}/%';`));
  const base = () => ({ supplierId: fx.supplierId, economicDate: fx.day, amountNet: 100, amountTotal: 121, categoryId: fx.categoryId, nature: 'OPERATING' as const, lines: [LINE] });

  it('success: the object is uploaded, the purchase is registered with its metadata and the object is kept', async () => {
    const before = objects();
    const r = await createPurchaseWithAttachments(admin(), { ...base(), userId: users.ADMIN.id!, files: [file()], idempotencyKey: ref('UP1') });
    const [att] = await readTable<{ storage_path: string; file_name: string }>(admin(), 'purchase_attachment', (q) => q.eq('purchase_id', r.purchase_id));
    expect(att.file_name).toBe('factura.pdf');
    expect(att.storage_path.startsWith(`${users.ADMIN.id}/`)).toBe(true);
    expect(objects()).toBe(before + 1);
    expect((await listPurchases(admin())).map((p) => p.id)).toContain(r.purchase_id);
  });

  it('a refused purchase removes the object it uploaded and surfaces the original error', async () => {
    const before = objects();
    const err = await createPurchaseWithAttachments(admin(), { ...base(), userId: users.ADMIN.id!, files: [file()], idempotencyKey: ref('UP1') }).catch((e) => e);
    expect(code(err)).toBe('DUPLICATE_PURCHASE');
    expect(objects()).toBe(before);
  });

  it('OPERATOR: the upload is refused, so register_purchase is never called', async () => {
    const err = await createPurchaseWithAttachments(operator(), { ...base(), userId: users.OPERATOR.id!, files: [file()], idempotencyKey: ref('UP2') }).catch((e) => e);
    expect(code(err)).toBe('ATTACHMENT_UPLOAD_FAILED');
    expect(owner(`SELECT count(*) FROM purchases WHERE idempotency_key = '${ref('UP2')}';`)).toBe('0');
  });
});

describe('F27-D instruments: the lifecycle is RPC-only', () => {
  it('issued eCheq: issue lowers the supplier debt, debit hits the bank account, a debited instrument cannot be cancelled', async () => {
    const supBefore = await balance('SUPPLIER', fx.supplierId);
    const bankBefore = await balance('ACCOUNT', fx.bank);
    const i = await issueSupplierInstrument(admin(), {
      supplierId: fx.supplierId, type: 'ECHEQ', chequeNumber: ref('E1'), amount: 300, maturityDate: fx.day, issuedDate: fx.day,
      bankAccountId: fx.bank, externalRef: ref('ISS1'),
    });
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(supBefore - 300);
    expect(await balance('ACCOUNT', fx.bank)).toBe(bankBefore);
    await markSupplierInstrumentDebited(admin(), i.instrument_id, fx.day);
    expect(await balance('ACCOUNT', fx.bank)).toBe(bankBefore - 300);
    expect((await listInstruments(admin())).find((x) => x.id === i.instrument_id)?.estado).toBe('DEBITED');
    const cancel = await cancelSupplierInstrument(admin(), i.instrument_id, fx.day, 'error').catch((e) => e);
    expect(code(cancel)).toBe('INVALID_STATE');
    const wrong = await rejectCheque(admin(), i.instrument_id, fx.day, 'x').catch((e) => e);
    expect(code(wrong)).toBe('WRONG_DIRECTION');
  });

  it('an ISSUED cheque can be cancelled (supplier debt restored); a rejected issued cheque restores the debt too', async () => {
    const supBefore = await balance('SUPPLIER', fx.supplierId);
    const a = await issueSupplierInstrument(admin(), {
      supplierId: fx.supplierId, type: 'CHEQUE', chequeNumber: ref('C1'), amount: 100, maturityDate: fx.day, issuedDate: fx.day,
      bankAccountId: fx.bank, externalRef: ref('ISS2'),
    });
    await cancelSupplierInstrument(admin(), a.instrument_id, fx.day, 'mal emitido');
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(supBefore);
    const b = await issueSupplierInstrument(admin(), {
      supplierId: fx.supplierId, type: 'CHEQUE', chequeNumber: ref('C2'), amount: 50, maturityDate: fx.day, issuedDate: fx.day,
      bankAccountId: fx.bank, externalRef: ref('ISS3'),
    });
    const noReason = await rejectSupplierInstrument(admin(), b.instrument_id, fx.day, '').catch((e) => e);
    expect(code(noReason)).toBe('REASON_REQUIRED');
    await rejectSupplierInstrument(admin(), b.instrument_id, fx.day, 'rechazado por el banco');
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(supBefore);
  });

  it('received cheque: receive lowers the client balance, deposit → clear credits the bank, reject reverses both', async () => {
    const bankBefore = await balance('ACCOUNT', fx.bank);
    const r = await receiveCheque(admin(), {
      clienteId: fx.clientId, type: 'CHEQUE', chequeNumber: ref('R1'), amount: 700, maturityDate: fx.day, receivedAt: new Date().toISOString(), receiptId: ref('REC1'),
    });
    expect(await balance('CLIENT', fx.clientId)).toBe(-700);
    const clearEarly = await clearCheque(admin(), r.instrument_id, fx.day, fx.bank).catch((e) => e);
    expect(code(clearEarly)).toBe('INVALID_STATE');
    await depositCheque(admin(), r.instrument_id, fx.day);
    await clearCheque(admin(), r.instrument_id, fx.day, fx.bank);
    expect(await balance('ACCOUNT', fx.bank)).toBe(bankBefore + 700);
    await rejectCheque(admin(), r.instrument_id, fx.day, 'sin fondos');
    expect(await balance('ACCOUNT', fx.bank)).toBe(bankBefore);
    expect(await balance('CLIENT', fx.clientId)).toBe(0);
    const twice = await rejectCheque(admin(), r.instrument_id, fx.day, 'otra vez').catch((e) => e);
    expect(code(twice)).toBe('ALREADY_REJECTED');
    const dupReceipt = await receiveCheque(admin(), {
      clienteId: fx.clientId, type: 'CHEQUE', chequeNumber: ref('R9'), amount: 1, maturityDate: fx.day, receivedAt: new Date().toISOString(), receiptId: ref('REC1'),
    }).catch((e) => e);
    expect(code(dupReceipt)).toBe('DUPLICATE_RECEIPT');
  });

  it('a received eCheq endorsed to the supplier lowers the supplier debt; an endorsed instrument cannot be deposited', async () => {
    const supBefore = await balance('SUPPLIER', fx.supplierId);
    const r = await receiveCheque(admin(), {
      clienteId: fx.clientId, type: 'ECHEQ', chequeNumber: ref('R2'), amount: 120, maturityDate: fx.day, receivedAt: new Date().toISOString(), receiptId: ref('REC2'),
    });
    await endorseCheque(admin(), r.instrument_id, fx.supplierId, fx.day);
    expect(await balance('SUPPLIER', fx.supplierId)).toBe(supBefore - 120);
    const row = (await listInstruments(admin())).find((x) => x.id === r.instrument_id)!;
    expect(row).toMatchObject({ estado: 'ENDORSED', cliente_nombre: `${TAG} cliente`, endosado_nombre: `${TAG} proveedor` });
    const dep = await depositCheque(admin(), r.instrument_id, fx.day).catch((e) => e);
    expect(code(dep)).toBe('INVALID_STATE');
    const op = await depositCheque(operator(), r.instrument_id, fx.day).catch((e) => e);
    expect(denied(op)).toBe(true);
  });

  it('no direct path: instrument / ledger / posting rows cannot be written, even by ADMIN, and the helper refuses before the network', async () => {
    const [inst] = await readTable<{ id: string }>(admin(), 'financial_instrument', (q) => q.eq('cliente_id', fx.clientId).limit(1));
    const raw = await admin().from('financial_instrument').update({ estado: 'CLEARED' }).eq('id', inst.id).select();
    expect(raw.error !== null || (raw.data ?? []).length === 0).toBe(true);
    const posting = await admin().from('financial_posting').insert({ financial_account_id: fx.bank, signed_amount: 1, effective_date: fx.day }).select();
    expect(posting.error).not.toBeNull();
    const ledger = await admin().from('supplier_ledger').insert({ supplier_id: fx.supplierId, movement_type: 'ADJUSTMENT', signed_amount: -1, effective_date: fx.day }).select();
    expect(ledger.error).not.toBeNull();
    await expect(writeTable(admin(), 'financial_instrument' as never, 'update' as never, { estado: 'CLEARED' }, { id: inst.id }))
      .rejects.toThrow();
    expect((await listInstruments(admin())).find((x) => x.id === inst.id)?.estado).not.toBe('CLEARED');
  });
});
